// Shared error and placeholder atoms: a plain sentence per outage, the raw answer only behind Details,
// one Retry per shared outage, and loading slots that read as loading rather than as data.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Component = (props: Record<string, unknown>) => unknown;
type ErrorCopy = { sentence: string; next: string; detail: string; kind: string };
type FailureEntry = { source: string; error: unknown };
type FakeResponse = { status: number; statusText: string; text: () => Promise<string> };

const ui = await loadScreenModule(UI_SRC);
const React = ui.React as { createElement: (t: unknown, p: unknown) => unknown };
const getFetchError = ui.getFetchError as (res: FakeResponse, bodyMax?: number) => Promise<Error>;
const getErrorCopy = ui.getErrorCopy as (error: unknown, source: string) => ErrorCopy;
const getSharedFailure = ui.getSharedFailure as (entries: FailureEntry[]) => { sources: string[]; error: unknown } | null;

const SERVER_ERROR = "HTTP 500 Internal Server Error — relation core.outcomes does not exist at /srv/x.ts:42";

function render(name: string, props: Record<string, unknown>): RenderedNode {
  return renderScreen(React.createElement(ui[name] as Component, props)) as RenderedNode;
}

function getVisibleText(node: RenderedNode | string): string {
  if (typeof node === "string") return node;
  if (node.type === "details") return "";
  return node.children.map(getVisibleText).join(" ");
}

function getButtons(tree: RenderedNode): RenderedNode[] {
  return findNodes(tree, (n) => n.type === "button");
}

test("a non-OK response becomes an error carrying the status and a bounded, tag-free body slice", async () => {
  const body = `<html><body><h1>Internal error</h1><p>${"x".repeat(400)}</p></body></html>`;
  const error = await getFetchError({ status: 502, statusText: "Bad Gateway", text: async () => body });
  const [statusLine, slice] = error.message.split(" — ");

  assert.equal(statusLine, "HTTP 502 Bad Gateway");
  assert.doesNotMatch(slice, /<\/?[a-z]/i);
  assert.ok(slice.length <= 120, `slice length ${slice.length}`);
});

test("an unreadable response body still yields the status line", async () => {
  const error = await getFetchError({ status: 503, statusText: "Service Unavailable", text: async () => { throw new Error("stream closed"); } });

  assert.equal(error.message, "HTTP 503 Service Unavailable");
});

test("error copy is one plain sentence naming the source plus a next step, never the raw answer", () => {
  const rows = [
    { name: "server error string", error: SERVER_ERROR, kind: "server" },
    { name: "client error object", error: new Error("HTTP 404 Not Found — {\"error\":\"no route\"}"), kind: "client" },
    { name: "network failure", error: new TypeError("Failed to fetch"), kind: "network" },
    { name: "unclassified failure", error: "boom", kind: "unknown" },
  ];
  for (const row of rows) {
    const copy = getErrorCopy(row.error, "task results");
    const raw = row.error instanceof Error ? row.error.message : row.error;

    assert.equal(copy.kind, row.kind, row.name);
    assert.equal(copy.sentence, "Couldn't load task results.", row.name);
    assert.equal(copy.detail, raw, row.name);
    assert.doesNotMatch(`${copy.sentence} ${copy.next}`, /HTTP|\d{3}|—/, row.name);
  }
});

test("a region failure shows the sentence and next step, and keeps the raw answer inside a collapsed Details", () => {
  const tree = render("RegionUnavailable", { source: "spend by model", error: SERVER_ERROR });
  const details = findNodes(tree, (n) => n.type === "details");

  assert.match(getVisibleText(tree), /Couldn't load spend by model\./);
  assert.doesNotMatch(getVisibleText(tree), /HTTP 500|core\.outcomes|\/srv\//);
  assert.equal(details.length, 1);
  assert.equal(details[0].props.open, undefined);
  assert.match(collectText(details[0]), /Details[\s\S]*HTTP 500 Internal Server Error/);
  assert.equal(findNodes(tree, (n) => n.props.role === "alert" || n.props.role === "status").length, 0);
});

test("a region failure offers Retry only when no page banner already carries it", () => {
  const rows = [
    { name: "own retry", onRetry: () => {}, buttons: 1 },
    { name: "covered by banner", onRetry: undefined, buttons: 0 },
  ];
  for (const row of rows) {
    const tree = render("RegionUnavailable", { source: "spend", error: SERVER_ERROR, onRetry: row.onRetry });

    assert.equal(getButtons(tree).length, row.buttons, row.name);
  }
});

test("a region failure reserves the slot height it was given", () => {
  const tree = render("RegionUnavailable", { source: "spend", error: SERVER_ERROR, minHeight: 218 });

  assert.equal(((tree.children[0] as RenderedNode).props.style as { minHeight: number }).minHeight, 218);
});

test("an outage shared by two or more failed regions collapses to one cause; mixed or single failures do not", () => {
  const down = (source: string, error: unknown = SERVER_ERROR) => ({ source, error });
  const rows = [
    { name: "two regions, same status", entries: [down("spend"), down("sessions"), { source: "models", error: null }], sources: ["spend", "sessions"] },
    { name: "two network failures", entries: [down("a", new TypeError("Failed to fetch")), down("b", new TypeError("Failed to fetch"))], sources: ["a", "b"] },
    { name: "one failure", entries: [down("spend"), { source: "sessions", error: null }], sources: null },
    { name: "different causes", entries: [down("spend"), down("sessions", "HTTP 404 Not Found")], sources: null },
    { name: "nothing failed", entries: [{ source: "spend", error: null }], sources: null },
    { name: "two regions fed by one source", entries: [down("agent summary"), down("agent summary")], sources: null },
  ];
  for (const row of rows) {
    const shared = getSharedFailure(row.entries);

    assert.deepEqual(shared && shared.sources, row.sources, row.name);
  }
});

test("the page banner announces one outage with every source named and exactly one Retry", () => {
  const tree = render("PageErrorBanner", { sources: ["spend", "sessions", "models"], error: SERVER_ERROR, onRetry: () => {} });
  const alerts = findNodes(tree, (n) => n.props.role === "alert");

  assert.equal(alerts.length, 1);
  assert.match(getVisibleText(tree), /Couldn't load spend, sessions, and models\./);
  assert.doesNotMatch(getVisibleText(tree), /HTTP 500/);
  assert.equal(getButtons(tree).length, 1);
});

function getByClass(tree: RenderedNode, name: string): RenderedNode[] {
  return findNodes(tree, (n) => String(n.props.className ?? "").split(/\s+/).includes(name));
}

test("the page banner is a raised critical alert card: severity word first, Details in the content, Retry in the actions", () => {
  const tree = render("PageErrorBanner", { sources: ["spend", "sessions"], error: SERVER_ERROR, onRetry: () => {} });
  const [content] = getByClass(tree, "alert-card-content");
  const [actions] = getByClass(tree, "alert-card-actions");

  assert.ok(String(getByClass(tree, "alert-card")[0]?.props.className).split(/\s+/).includes("card"), "raised card shell");
  assert.equal(getByClass(tree, "alert-card")[0]?.props["data-tone"], "crit");
  assert.equal(collectText(getByClass(tree, "sr-only")[0]).trim(), "Critical:");
  assert.equal(findNodes(content, (n) => n.type === "details").length, 1, "Details sit in the content column");
  assert.equal(getButtons(actions).length, 1, "the one Retry sits in the actions slot");
});

test("an alert card announces by placement: a standalone critical card is an alert, other tones a status, none inside a live host", () => {
  const rows = [
    { name: "standalone crit", props: { tone: "crit" }, role: "alert" },
    { name: "standalone warn", props: { tone: "warn" }, role: "status" },
    { name: "standalone info", props: { tone: "info" }, role: "status" },
    { name: "standalone ok", props: { tone: "ok" }, role: "status" },
    { name: "standalone neutral", props: { tone: "neutral" }, role: "status" },
    { name: "crit inside a live host", props: { tone: "crit", hasLiveHost: true }, role: undefined },
  ];
  for (const row of rows) {
    const tree = render("AlertCard", { title: "Spend over budget", ...row.props });
    const roles = findNodes(tree, (n) => n.props.role != null).map((n) => n.props.role);

    assert.deepEqual(roles, row.role ? [row.role] : [], row.name);
  }
});

test("an alert card leads its title with a visually-hidden severity word, so tone never rests on colour or glyph alone", () => {
  const rows = [
    { tone: "crit", word: "Critical:" },
    { tone: "warn", word: "Warning:" },
    { tone: "info", word: "Notice:" },
    { tone: "ok", word: "Resolved:" },
    { tone: "neutral", word: "Notice:" },
  ];
  for (const row of rows) {
    const tree = render("AlertCard", { tone: row.tone, title: "Harness drift" });
    const [title] = getByClass(tree, "alert-card-title");

    assert.equal(collectText(getByClass(title, "sr-only")[0]).trim(), row.word, row.tone);
    assert.match(collectText(title), new RegExp(`^${row.word}\\s*Harness drift$`), row.tone);
    assert.equal(getByClass(tree, "alert-card")[0].props["data-tone"], row.tone, `${row.tone} tone rides on the card for its well`);
  }
});

test("an alert card renders each optional slot only when given, on the surface the caller picked", () => {
  const rows = [
    { name: "title only, raised", props: { surface: "raised" }, shell: "card", subjects: 0, details: 0, actions: 0 },
    { name: "every slot, inset", props: { surface: "inset", subjects: ["hooks", "rules"], details: "ENOENT", actions: "Retry" }, shell: "sub-card", subjects: 2, details: 1, actions: 1 },
  ];
  for (const row of rows) {
    const tree = render("AlertCard", { tone: "warn", title: "Harness drift", ...row.props });
    const [chips] = getByClass(tree, "alert-card-subjects");

    assert.ok(String(getByClass(tree, "alert-card")[0].props.className).split(/\s+/).includes(row.shell), `${row.name}: shell`);
    assert.equal(chips ? chips.children.length : 0, row.subjects, `${row.name}: subject chips`);
    assert.equal(findNodes(tree, (n) => n.type === "details").length, row.details, `${row.name}: details`);
    assert.equal(getByClass(tree, "alert-card-actions").length, row.actions, `${row.name}: actions`);
  }
});

const FAILURE_SENTENCE = /Couldn't load/g;
const COVERED_NOTE = "Not loaded — see the notice above";

function renderPage(entries: FailureEntry[]): RenderedNode {
  const shared = getSharedFailure(entries);
  const banner = shared && React.createElement(ui.PageErrorBanner as Component, { sources: shared.sources, error: shared.error, onRetry: () => {} });
  const regions = entries.map((entry) => React.createElement(ui.RegionFailure as Component, { ...entry, shared, onRetry: () => {} }));
  return renderScreen(React.createElement("div", { children: [banner, ...regions] })) as RenderedNode;
}

test("each failed region speaks once: a shared outage leaves one sentence and one Retry, anything else keeps every card", () => {
  const rows = [
    { name: "two same-cause failures → banner speaks, regions stay quiet", entries: [{ source: "spend", error: SERVER_ERROR }, { source: "sessions", error: SERVER_ERROR }], sentences: 1, retries: 1, quiet: 2 },
    { name: "a lone failure keeps its own card", entries: [{ source: "spend", error: SERVER_ERROR }], sentences: 1, retries: 1, quiet: 0 },
    { name: "a mixed-cause pair keeps both cards", entries: [{ source: "spend", error: SERVER_ERROR }, { source: "sessions", error: "HTTP 404 Not Found" }], sentences: 2, retries: 2, quiet: 0 },
  ];
  for (const row of rows) {
    const tree = renderPage(row.entries);
    const text = getVisibleText(tree);

    assert.equal((text.match(FAILURE_SENTENCE) || []).length, row.sentences, row.name);
    assert.equal(getButtons(tree).length, row.retries, row.name);
    assert.equal(text.split(COVERED_NOTE).length - 1, row.quiet, row.name);
  }
});

type SourceEntry = { source: string; region?: string; error: unknown };
type SourceFailures = { banner: { sources: string[]; error: unknown } | null; speakers: Map<string, string> };
const getSourceFailures = ui.getSourceFailures as (entries: SourceEntry[]) => SourceFailures;
const QUIET_NOTE = /Not loaded —/g;

function renderSourcePage(entries: SourceEntry[]): RenderedNode {
  const failures = getSourceFailures(entries);
  const banner = failures.banner && React.createElement(ui.PageErrorBanner as Component, { sources: failures.banner.sources, error: failures.banner.error, onRetry: () => {} });
  const failed = entries.filter((entry) => entry.error != null);
  const regions = failed.map((entry) => React.createElement(ui.RegionFailure as Component, { ...entry, failures, onRetry: () => {} }));
  return renderScreen(React.createElement("div", { children: [banner, ...regions] })) as RenderedNode;
}

test("each failed source speaks once however many regions it feeds; one surface and one Retry per failed source", () => {
  const summary = (region: string, error: unknown = SERVER_ERROR) => ({ source: "agent summary", region, error });
  const runs = (region: string, error: unknown = SERVER_ERROR) => ({ source: "recent runs", region, error });
  const rows = [
    { name: "one source feeding three regions", entries: [summary("fleet KPIs"), summary("agent table"), summary("suspended agents")], sentences: 1, retries: 1, quiet: 2 },
    { name: "two sources with different causes", entries: [summary("fleet KPIs"), summary("agent table"), runs("run list", "HTTP 404 Not Found"), runs("run chart", "HTTP 404 Not Found")], sentences: 2, retries: 2, quiet: 2 },
    { name: "two sources with the same cause share one banner", entries: [summary("fleet KPIs"), summary("agent table"), runs("run list"), runs("run chart")], sentences: 1, retries: 1, quiet: 4 },
    { name: "a healthy source beside a failed one adds nothing", entries: [summary("fleet KPIs"), runs("run list", null)], sentences: 1, retries: 1, quiet: 0 },
  ];
  for (const row of rows) {
    const tree = renderSourcePage(row.entries);
    const text = getVisibleText(tree);

    assert.equal((text.match(FAILURE_SENTENCE) || []).length, row.sentences, row.name);
    assert.equal(getButtons(tree).length, row.retries, row.name);
    assert.equal((text.match(QUIET_NOTE) || []).length, row.quiet, row.name);
  }
});

test("the first region a failed source feeds carries its card; the others name themselves and point at that source", () => {
  const tree = renderSourcePage([
    { source: "agent summary", region: "fleet KPIs", error: SERVER_ERROR },
    { source: "agent summary", region: "suspended agents", error: SERVER_ERROR },
  ]);
  const [speaker, covered] = tree.children as RenderedNode[];

  assert.match(getVisibleText(speaker), /Couldn't load agent summary\./);
  assert.equal(getVisibleText(covered).replace(/\s+/g, " ").trim(), "Suspended agents Not loaded — see the agent summary notice");
  assert.equal(findNodes(covered, (n) => n.props["data-covered-card-id"] != null).length, 0);
});

test("a covered region names itself, reserves its slot height and carries no alert, Retry or Details", () => {
  const tree = render("RegionCovered", { source: "spend by model", minHeight: 218 });

  assert.equal(getVisibleText(tree).replace(/\s+/g, " ").trim(), `Spend by model ${COVERED_NOTE}`);
  assert.equal(((tree.children[0] as RenderedNode).props.style as { minHeight: number }).minHeight, 218);
  assert.equal(findNodes(tree, (n) => n.type === "button" || n.type === "details" || n.props.role === "alert").length, 0);
});

test("the loading placeholder is visible text under a status role and reserves its slot height", () => {
  const tree = render("LoadingPlaceholder", { label: "sessions", minHeight: 200 });
  const status = findNodes(tree, (n) => n.props.role === "status");

  assert.equal(status.length, 1);
  assert.match(collectText(status[0]), /Loading sessions…/);
  assert.equal((status[0].props.style as { minHeight: number }).minHeight, 200);
});

test("skeleton rows fill the real table body at the given row height and stay hidden from assistive tech", () => {
  const tree = render("SkeletonRows", { rows: 3, columns: 4, rowHeight: 40 });
  const rows = findNodes(tree, (n) => n.type === "tr");

  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.props["aria-hidden"], "true");
    assert.equal((row.props.style as { height: number }).height, 40);
    assert.equal(findNodes(row, (n) => n.type === "td").length, 4);
  }
});

test("screens reach the shared Retry control through window.UI, so their own Retry keeps the busy and focus contract", () => {
  const exposed = (ui.window as { UI: Record<string, unknown> }).UI;

  assert.equal(typeof ui.RetryButton, "function");
  assert.equal(exposed.RetryButton, ui.RetryButton);
});
