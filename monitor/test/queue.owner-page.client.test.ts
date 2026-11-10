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
const realUi = ((await loadScreenModule(UI_SRC)) as { UI: Record<string, unknown> }).UI;

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

const screen = (await loadScreenModule(QUEUE_SRC, { window: { UI: uiStub() } })) as ScreenModule;
// vm-realm values → this realm's prototypes, so deepEqual compares content
const getPlain = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const call = <T>(name: string, ...args: unknown[]): T => getPlain((screen[name] as (...a: unknown[]) => T)(...args));
const render = (name: string, props: unknown): RenderedNode => renderScreen(screen.React.createElement(screen[name] as Component, props)) as RenderedNode;

const SESSION_ID = "6f1c2a9e-4b7d-4e21-9a3f-0c5d8e7b1a42";

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

describe("owner auth from an HTTP status", () => {
  const rows = [
    { name: "401 signs the owner out", status: 401, expected: "out" },
    { name: "503 means the passphrase is not provisioned", status: 503, expected: "not_provisioned" },
    { name: "a 2xx answer means signed in", status: 200, expected: "in" },
    { name: "a conflict leaves the state unchanged", status: 409, expected: null },
  ];
  for (const row of rows) test(row.name, () => assert.equal(call("getAuthFromStatusQ", row.status), row.expected));
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
      const text = collectText(render("CardStateQ", { item: buildItem({ status: "answered", deviation: row.deviation }) }));
      assert.ok(text.includes(row.expected), text);
      assert.equal(text.includes("atrium-queue.sh pending"), row.hasCommand === true, text);
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
  const markedLine =
    "waiting on personal · wt/owner-queue · 9b2e7c41, whose automatic resume has not registered: this one waits until that session registers " +
    "or is resumed in a terminal (see its card), and resumes automatically once that session has then ended";
  const generic = "another session is live or resuming in this worktree: this one resumes automatically once that one has ended";
  const markedSession = (bgId: string | null, configDir: string | null = null) =>
    buildSession({ marker: { setAt: "2026-11-10T06:20:11.204Z", bgId }, configDir });
  const pending = (skipReason: unknown, extra: Record<string, unknown> = {}) => buildItem({ status: "resume_pending", skipReason, ...extra });
  const rows = [
    { name: "a used attempt asks for Resend", item: pending({ kind: "resume_used" }), expected: ["automatic resume used — Resend to try again"] },
    { name: "an approval item needs the terminal", item: pending({ kind: "approval" }), expected: ["approval needs your terminal: resume the session yourself"] },
    { name: "a resume in flight shows no text", item: pending({ kind: "in_flight" }), expected: [] },
    { name: "no marked occupant gives the generic worktree line", item: pending({ kind: "shared_worktree", markedOccupants: [], hasUnmarkedOccupant: true }), expected: [generic] },
    { name: "a marked occupant is named", item: pending({ kind: "shared_worktree", markedOccupants: [occupant], hasUnmarkedOccupant: false }), expected: [markedLine] },
    {
      name: "a marked and a live occupant give the marked line then the generic line",
      item: pending({ kind: "shared_worktree", markedOccupants: [occupant], hasUnmarkedOccupant: true }),
      expected: [markedLine, generic],
    },
    {
      name: "the captured-id marker form names the bg id and the profile",
      item: pending({ kind: "marker" }, { session: markedSession("bg-7f3a") }),
      expected: [
        "the resumed session may still be running in the background: under profile work-dev, check it with `claude logs bg-7f3a`, " +
          "and resume it yourself in a terminal only after `claude stop bg-7f3a`",
      ],
    },
    {
      name: "the listing marker form names the cwd and the full session id",
      item: pending({ kind: "marker" }, { session: markedSession(null) }),
      expected: [
        "the resumed session may still be running in the background: under profile work-dev, check `claude agents --json --cwd " +
          `/Users/owner/Desktop/git/glass-atrium\` for the entry of session ${SESSION_ID}, and resume it yourself in a terminal only once that ` +
          "entry is no longer listed, or after `claude stop <id>` with that entry's id",
      ],
    },
    {
      name: "the marker on an unacked card of a marked session replaces any skip text",
      item: buildItem({ status: "unacked", deviation: "unacked", session: markedSession("bg-7f3a") }),
      expected: [
        "the resumed session may still be running in the background: under profile work-dev, check it with `claude logs bg-7f3a`, " +
          "and resume it yourself in a terminal only after `claude stop bg-7f3a`",
      ],
    },
  ];
  for (const row of rows) test(row.name, () => assert.deepEqual(call("getCardNotesQ", row.item), row.expected));

  const configRows = [
    { name: "captured-id form carries the recorded config dir", bgId: "bg-7f3a", count: 2 },
    { name: "listing form carries the recorded config dir", bgId: null, count: 2 },
  ];
  for (const row of configRows) {
    test(row.name, () => {
      const [note] = call<string[]>("getCardNotesQ", buildItem({ session: markedSession(row.bgId, "/Users/owner/.claude-work-dev") }));
      assert.equal(note?.split("CLAUDE_CONFIG_DIR=/Users/owner/.claude-work-dev claude ").length, row.count + 1, note);
    });
  }

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

  test("the page list holds every item's resumes newest first", () => {
    const at = (iso: string, attempt: number) => ({ attempt, sentAt: iso, result: "sent", abortReason: null, bgId: null });
    const items = [
      buildItem({ id: 1, resumes: [at("2026-11-10T05:01:00.120Z", 1)] }),
      buildItem({ id: 2, resumes: [at("2026-11-10T06:40:00.870Z", 2), at("2026-11-10T04:10:00.450Z", 1)] }),
    ];
    const order = call<Array<{ itemId: number; attempt: number }>>("getRecentResumesQ", items).map((resume) => `${resume.itemId}/${resume.attempt}`);
    assert.deepEqual(order, ["2/2", "1/1", "2/1"]);
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
});
