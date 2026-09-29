// The Wiki fetch path settles each read into its shared region state: a failed refresh keeps the
// last good payload, a superseded request lands nothing, and only a successful read advances the stamp.
//
// Runner: npx tsx --test test/wiki.freshness-stamp.client.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildScreenSandbox } from "./client-sandbox.js";
import { createReactStub, loadScreenModule } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIKI_SRC = resolve(__dirname, "../public/src/screens/wiki.jsx");
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

interface RegionState {
  status: string;
  data: unknown;
  error: string | null;
  busy: boolean;
}
type Update = (state: RegionState) => RegionState;
interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}
interface WikiSandbox {
  window: {
    UI: {
      INITIAL_REGION_STATE: RegionState;
      putRegionRequest: (state: RegionState, key: string, request: object) => RegionState;
    };
  };
  fetch: (url: string) => Promise<FetchResponse>;
  runFetchW: (url: string, request: AbortController, setState: (update: Update) => void) => Promise<boolean>;
}

const sandbox = await buildScreenSandbox<WikiSandbox>(WIKI_SRC);
const URL_SUMMARY = "/api/wiki/summary";
const HELD = { cycle_p95_ms: 4200 };

function respond(ok: boolean, payload: unknown): void {
  sandbox.fetch = async () => ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Internal Server Error",
    json: async () => payload,
    text: async () => String(payload),
  });
}

// A region already showing HELD, with a refresh for `request` in flight.
function startRefresh(request: AbortController): { read: () => RegionState; setState: (update: Update) => void } {
  const { INITIAL_REGION_STATE, putRegionRequest } = sandbox.window.UI;
  let state: RegionState = putRegionRequest({ ...INITIAL_REGION_STATE, status: "ready", data: HELD, busy: false }, URL_SUMMARY, request);
  return { read: () => state, setState: (update) => { state = update(state); } };
}

test("a failed refresh keeps the section's last good payload and records the failure beside it", async () => {
  const request = new AbortController();
  const region = startRefresh(request);
  respond(false, "<p>relation missing</p>");

  assert.equal(await sandbox.runFetchW(URL_SUMMARY, request, region.setState), false, "a failure never advances the stamp");
  assert.equal(region.read().data, HELD, "the held payload stays on screen");
  assert.equal(region.read().busy, false);
  assert.match(String(region.read().error), /^HTTP 500/);
});

test("a successful read replaces the payload only for the request in flight", async () => {
  const fresh = { cycle_p95_ms: 900 };
  respond(true, fresh);
  for (const isCurrent of [true, false]) {
    const request = new AbortController();
    const region = startRefresh(request);
    const sender = isCurrent ? request : new AbortController();

    assert.equal(await sandbox.runFetchW(URL_SUMMARY, sender, region.setState), true, "a read that answered counts as read");
    assert.equal(region.read().data, isCurrent ? fresh : HELD, `current=${isCurrent}`);
  }
});

// The page verdict reads the same freshness state as the header stamp.

interface Verdict {
  state: string;
  tone: string;
  label: string;
  note: string | null;
}
interface VerdictProps {
  tone: string;
  label?: string;
  freshness?: object;
}
interface Element {
  type: unknown;
  props: VerdictProps & { children?: unknown };
}
interface PageUi {
  INITIAL_REGION_STATE: RegionState;
  putRegionRequest: (state: RegionState, key: string, request: object) => RegionState;
  getFreshnessVerdict: (input: object) => Verdict;
  PageVerdict: unknown;
}

const pageUi = ((await loadScreenModule(UI_SRC)) as unknown as { UI: PageUi }).UI;
const WAVE_URLS = ["summary", "cycles", "index", "backlog", "reports"];

// Region states and the settled stamp handed to the screen's hooks in declaration order.
let seeds: { regions: RegionState[]; settledAt: string | null } = { regions: [], settledAt: null };
const seededReact = createReactStub();
seededReact.useState = (initial: unknown) => {
  if (initial === pageUi.INITIAL_REGION_STATE) return [seeds.regions.shift() ?? initial, () => undefined];
  if (initial === null) return [seeds.settledAt, () => undefined];
  return [typeof initial === "function" ? (initial as () => unknown)() : initial, () => undefined];
};
const page = (await loadScreenModule(WIKI_SRC, { UI: pageUi, React: seededReact })) as unknown as {
  ScreenWiki: (props: object) => unknown;
};

function findElement(node: unknown, type: unknown): Element | undefined {
  if (Array.isArray(node)) return node.map((child) => findElement(child, type)).find(Boolean);
  if (!node || typeof node !== "object") return undefined;
  const element = node as Element;
  if (element.type === type) return element;
  return findElement(element.props?.children, type);
}

// Mirrors PageVerdict: the shared rule applies only when the page hands it the freshness inputs.
function readPageVerdict(regions: RegionState[], settledAt: string | null): Verdict {
  seeds = { regions: [...regions], settledAt };
  const props = findElement(page.ScreenWiki({}), pageUi.PageVerdict)?.props;
  assert.ok(props, "the screen renders one page verdict");
  if (!props.freshness) return { state: "unwired", tone: props.tone, label: props.label ?? "", note: null };
  return pageUi.getFreshnessVerdict({ ...props.freshness, tone: props.tone, label: props.label });
}

test("while the first read is in flight the verdict reads the shared not-read form", () => {
  const request = new AbortController();
  const regions = WAVE_URLS.map((url) => pageUi.putRegionRequest(pageUi.INITIAL_REGION_STATE, url, request));

  const verdict = readPageVerdict(regions, null);

  assert.equal(verdict.tone, "neutral");
  assert.equal(verdict.label, "No signal");
  assert.equal(verdict.note, "Checking the first read…");
});

test("a failed refresh over held data reads as last known with the failed count, never as healthy", () => {
  const settledAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const summary = { last_status: "ok", last_cycle_started_at: settledAt, latest_compiled_count: 2 };
  const held = (data: unknown): RegionState => ({ status: "ready", data, error: null, busy: false });
  const regions = [{ ...held(summary), error: "HTTP 500 Internal Server Error" }, held({}), held({}), held({}), held({})];

  const verdict = readPageVerdict(regions, settledAt);

  assert.match(verdict.label, /^Last known/);
  assert.notEqual(verdict.tone, "ok", "held data cannot raise an all-clear");
  assert.match(String(verdict.note), /^Read .* · 1 of 5 sources failed$/);
});
