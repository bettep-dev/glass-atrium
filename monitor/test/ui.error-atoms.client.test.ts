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
